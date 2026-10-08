# Manual builds and deployments

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork runs lightweight CI only. Tags and schedules do not publish releases, npm packages,
web previews, or production deployments. Build and publish explicitly when needed.

## Build web and server

Run focused checks for changed behavior as described in [development](./development.md#checks),
then build the web client and server:

```sh
vp i --frozen-lockfile
vp run --filter t3 build
```

The build puts the server bundle and bundled web client in `apps/server/dist`.
Use the pinned Bun version in `.bun-version` for development, executable compilation, and
archive packaging. Vite+ and pnpm remain contributor tooling.

## Build a standalone archive

Build on the archive's target host: macOS arm64, Linux x64, or Linux arm64. For example,
after the web/server build on Linux x64:

```sh
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p apps/server/dist/resource-monitor/linux-x64
cp native/resource-monitor/target/release/t3-resource-monitor apps/server/dist/resource-monitor/linux-x64/
bun apps/server/scripts/cli.ts build-exe --target linux-x64
version=$(bun -p "require('./apps/server/package.json').version")
bun scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" --output-dir /tmp/iglo-release
bun scripts/smoke-cli-archive.ts --archive "/tmp/iglo-release/t3-$version-linux-x64.tar.gz" --expect-version "$version"
```

Use the matching platform and architecture for other targets. The archive carries the web client,
native assets, disk-backed SDK dependencies, and a pinned interpreter at `runtime/bun` for helper
scripts. Installed execution needs no system Node, npm, or Bun. Publish archives and `SHA256SUMS`
to `iglo-tech/iglo.code`; installers and updates default to that fork and never fall back to upstream.
An explicit `T3CODE_RELEASE_BASE_URL` can point at a mirror.

Run the source/archive smoke and real-client checks locally on each target before publishing;
see [development checks](./development.md#checks). npm packaging tools remain available in
`scripts/` for manual use.

## T3 Connect relay deployment

Deploy relay stages locally using the credentials and configuration in the
[relay guide](../../infra/relay/README.md). The relay is versioned separately from client builds.

```sh
vp run --filter t3code-relay deploy -- --stage "$USER" --env-file .env.local
```

Use a personal stage for development. Deploy the shared `prod` stage explicitly with its production
configuration. Alchemy compares configured values and redeploys changed resources. A forced deploy
also replaces the Postgres runtime role and password, so use it only when needed.

### Managed tunnel cleanup rollout

Keep `RELAY_TUNNEL_CLEANUP_MODE=off` for the first production deploy. That deploy applies the
nullable allocation migration and adds the recovery endpoints. Web and mobile clients need no
coordinated release. CLI server builds must reach users before cleanup is enabled,
because those builds register recovery and replace a deleted tunnel after wake.

1. Deploy the relay and migration with cleanup `off`.
2. Release the server build and confirm current hosts register recovery. Older hosts stay marked
   legacy and are only candidates under the legacy switch below.
3. Set `dry-run`, run a relay deploy, and read the sweep counters (`scanned`, `wouldDelete`,
   `skippedLegacy`, `skippedOrphan`, `failed`, `truncated`) across several sweeps. Each sweep records
   them, and the active `mode`, as `relay.managed_endpoint_reaper.*` attributes on its
   `relay.managed_endpoint_reaper.sweep` span in Axiom.
4. Run the disposable-host canary below.
5. Set `enabled` only after the canary recovers without a server restart.

The job runs every five minutes with a five-minute grace period for tunnels that lost their
connector, so a candidate is usually removed five to ten minutes after it goes down. Tunnels that
never connected wait an hour. One sweep attempts at most 100 deletions, so a backlog takes longer.
Changing `RELAY_TUNNEL_CLEANUP_MODE`, including turning cleanup off during an incident, needs a relay
deploy without force. Confirm the new `mode` on the next sweep span.

To roll back, set cleanup to `off` and run a relay deploy before downgrading any host. Keep the
recovery endpoints deployed while current server builds are in use. The nullable columns can stay.

### Legacy tunnel cleanup

A legacy tunnel belongs to a host that never registered recovery, usually one that went offline
before the recovery build shipped. `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` deletes these once Cloudflare
reports them down, or never connected, for more than 7 days. It is independent of
`RELAY_TUNNEL_CLEANUP_MODE`, and every other check still applies.

A deleted legacy tunnel keeps its allocation, so its hostname is kept. When the host comes back:

- On a build with recovery, the connector is rejected and the host requests a replacement tunnel at
  the same hostname.
- On an older build with a CLI link, startup provisions a new tunnel.
- On an older build linked from web or mobile, the host stays offline until T3 Code on that computer
  is updated.

Ship the web and mobile builds that show the offline reason before enabling legacy cleanup, so a
user whose host is affected sees what to do. The relay adds the `tunnel_released_at` allocation
column in its first deploy with this change; the legacy switch stays `off` until you set it.

1. Run `vp run --filter t3code-relay tunnels:census` with a read-only Cloudflare token. It counts
   tunnels in every relay stage. The reaper only sees its own stage's tunnels, so clean up the rest
   by hand.
2. Set the legacy mode to `dry-run`, deploy, and read `wouldDeleteLegacy`, `legacyOver30Days`,
   `totalDown`, and `totalInactive` on the sweep spans for a day. `wouldDeleteLegacy` counts only the
   tunnels a sweep inspected, at most 500 per status. `totalDown` and `totalInactive` are Cloudflare's
   counts of this stage's tunnels down for over five minutes and never connected for over an hour.
   They include ones the reaper skips, so they are an upper bound on the backlog. The share of `wouldDeleteLegacy` in each sweep's `scanned` estimates how
   much of that total is eligible.
3. Run the legacy steps of the disposable-host canary below.
4. Before enabling, confirm the web and mobile builds that show the "update T3 Code on that computer"
   message are live. Without them, a user whose older host lost its tunnel only sees it as offline.
5. Set the legacy mode to `enabled`. One sweep deletes at most 100 tunnels, four at a time, and
   stops starting new deletions after 90 seconds. A backlog of 20,000 takes about 17 hours if each
   sweep finishes its 100. Watch `deletedLegacy`, `attempted`, `failed`, and `truncated`. An
   `attempted` well under 100 with `truncated` set means the sweep stopped early: either the time
   budget ran out or Cloudflare rate-limited a deletion. The counters don't say which; the relay
   logs a warning with the Cloudflare error for each failed deletion.

In Axiom, filter the relay traces dataset on `name == "relay.managed_endpoint_reaper.sweep"` and
chart the `attributes.custom.relay.managed_endpoint_reaper.*` fields over time.

Set the legacy mode back to `off` and deploy if any of these happen:

- `failed` stays above a few per sweep. Read the warning log for the Cloudflare error.
- Users report an environment that is offline with the update message after they have updated T3
  Code on that computer and restarted it.
- Relay request errors rise while sweeps run. Deletions share the Postgres connection pool with
  request handlers.

Turning the legacy mode off stops new legacy deletions; `RELAY_TUNNEL_CLEANUP_MODE` keeps deleting
tunnels of hosts with recovery while it is `enabled`. Deleted tunnels stay deleted; their hosts
recover as described above.

### Disposable-host canary

This test has not been run against a real Cloudflare account. Run it against a disposable relay
stage, test Cloudflare account, disposable host, and disposable T3 home. Keep production cleanup at
`off` or `dry-run` until it passes. Do not stop a daily-use T3 server.

1. Deploy the disposable stage with cleanup `dry-run`. Link a first disposable environment through
   web or mobile settings and confirm its tunnel is healthy and recovery is registered.
2. Stop that host and restart the same T3 home on a different local port. Confirm the public
   hostname reaches the new port and sends nothing to the old one.
3. Link a second disposable environment with a server build that predates recovery registration.
   Capture its managed `cloudflared` child PID, confirm it belongs to that host, and pause only that
   child with `kill -STOP <legacy-pid>`. Wait until Cloudflare reports it down for over five minutes.
4. Capture the first environment's `cloudflared` child PID from its server logs, confirm ownership,
   and pause it with `kill -STOP <first-pid>`. Wait until Cloudflare reports it down for over five
   minutes.
5. Confirm dry-run counts the first tunnel in `wouldDelete` and the second in `skippedLegacy`.
6. Set cleanup `enabled` on the disposable stage and deploy. Confirm in the test Cloudflare account
   that the first tunnel is deleted and the legacy tunnel still exists.
7. Resume the first child with `kill -CONT <first-pid>`. Confirm the running server detects the
   repeated rejection, requests recovery, and becomes reachable at the same hostname without a
   restart.
8. Resume the legacy child with `kill -CONT <legacy-pid>` and confirm its tunnel reconnects.
9. Repeat with a physical sleep and wake cycle on a disposable laptop before broad rollout.

Legacy cleanup, on the same disposable stage:

10. Set `RELAY_LEGACY_TUNNEL_GRACE_MINUTES=10` and the legacy mode to `dry-run`, then deploy. The
    override shortens the 7-day grace period and is ignored on `prod`. Pause the legacy child again
    and wait until Cloudflare reports it down for over ten minutes.
11. Confirm the sweep counts it in `wouldDeleteLegacy`, then set the legacy mode to `enabled` and
    deploy. Confirm the legacy tunnel is deleted and its allocation row remains.
12. With the legacy host still on its old build, resume the child. A CLI-linked host provisions a
    new tunnel on its next restart; a web- or mobile-linked host stays offline.
13. Update that host to the current build and start it. Confirm it requests recovery and is
    reachable at the same hostname.
14. Remove `RELAY_LEGACY_TUNNEL_GRACE_MINUTES` from the disposable stage.

## Server self-update release invariant

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
hosted client version must therefore have a matching `@iglo-tech/iglo-code@<version>` package available on
npm before users can receive that client.

When publishing manually, make the matching server package and CLI archives available before
exposing the hosted client. Publishing a client first would leave the **Update server** action
targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view @iglo-tech/iglo-code@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. When the release adds database migrations, verify that the
remote update applies them and reconnects. A failed trial must restore the database snapshot and
restart the previous server. If the installed launcher does not support the target protocol,
verify that the update stops before restart and run `bunx @iglo-tech/iglo-code@<version> service update` once on the
server machine. Also test the manual update guidance when those environments are available.
