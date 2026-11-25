# Development

## First checkout

The application runs on Bun (version pinned in `.bun-version`, minimum 1.4.4) on macOS arm64, macOS x64, Linux x64, and Linux arm64. The Vite+/pnpm contributor toolchain uses the Node version pinned in `package.json` (provided by `vp`) independently of the application runtime. Install Bun and Vite+ (`vp`) first:

```sh
curl -fsSL https://vite.plus | bash
```

```sh
git clone https://github.com/iglo-tech/iglo.code.git
cd iglo.code
vp i
vp run dev
```

Open the pairing URL printed by the dev runner (the bare origin does not authenticate a new browser). Set up a coding agent with the [provider guide](../user/install.md#providers).

For pull requests in this fork, set GitHub CLI's default repository after adding an `upstream` remote, otherwise `gh` prefers upstream and the PR action can fail with `head invalid` for a branch pushed only to the fork. The setting is shared by linked worktrees; repeat it for a fresh clone:

```sh
gh repo set-default origin
gh repo set-default --view   # iglo-tech/iglo.code
```

## Running dev servers

- `vp run dev` (server + web), `vp run dev:server`, `vp run dev:web`. Pass flags directly after the task name (e.g. `vp run dev --home-dir /tmp/iglo-code-dev`, `--browser`).
- To stop a worktree's dev stack when its thread settles, import the **Dev** action from `iglo.code.json` (Settings > Projects > Actions); its `stopOnSettle` option stops the terminal and its children. `vp run dev` in an agent's own shell does not attach to this lifecycle.
- **State and ports:** Linked worktrees default to `<worktree>/.iglo.code/userdata`, outranking `IGLO_CODE_HOME`. Any other checkout (main checkout, plain clone) uses `IGLO_CODE_HOME` when set, otherwise `~/.iglo.code/dev`, and checkouts sharing it share one database and can run one server at a time. An explicit `--home-dir` wins in both cases. A home of `~/.iglo.code` still selects `~/.iglo.code/dev`, because `~/.iglo.code/userdata` is the live install. Never run a dev server against it; see [test data](../../AGENTS.md#test-data).
- **Seeding:** The first start in a worktree seeds its empty database from a read-only copy of `~/.iglo.code/userdata/statev2.sqlite` when it is at most 500 MiB (larger sources warn and start empty; `--no-seed` or `IGLO_CODE_DEV_SEED=0` skips). Seeding targets only a worktree's own `.iglo.code`. For a plain clone run `vp run migrate-dev-db --base-dir <clone>/.iglo.code`, then `vp run dev --home-dir <clone>/.iglo.code`. `vp run migrate-dev-db` with dev stopped refreshes manually and may use substantial disk before pruning.
- Read actual ports from `[dev-runner]` output; worktrees derive stable preferences from their path and occupied ports shift them (`IGLO_CODE_PORT_OFFSET` / `IGLO_CODE_DEV_INSTANCE` override).
- **Resource monitor:** First start builds `native/resource-monitor` via Cargo when missing; without Rust, dev starts with a warning and no process telemetry (`vp run build:resource-monitor` after installing Rust).
- **Startup profiling:** `vp run profile:startup` captures the first 20 s of server processes under `.iglo.code/startup-profiles/<timestamp>`.

### Replay provider

`vp run dev` registers `Replay (dev)` ([dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts)), a local ACP agent that plays recorded transcripts with simulated streaming, so the real adapter, orchestration, and UI run without a paid model. Each scenario is a model and each prompt plays the next recorded turn. Bundled servers skip it; dev servers add it back on start, so turn it off in Settings instead of removing it. Add a `SCENARIOS` entry pointing at a generic ACP fixture (`registry_transcript.ndjson`) or a file in [dev-replay](../../apps/server/scripts/dev-replay). It drops session setup and vendor frames, so Grok and fx recordings lose vendor-only behavior.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL; give the tester the complete URL, including its token. The runner removes its mapping on exit. Never set `VITE_HTTP_URL` or `VITE_WS_URL` in dev; Vite proxies `/api` and `/ws` single-origin so one build works over localhost and remote connections.

Shared runs use bundled dev to avoid a network round trip per import level (`IGLO_CODE_BUNDLED_DEV=0` opts out). Traps when changing it:

- The web entry must dynamically import the app so React refresh initializes before application chunks.
- Bundled dev rebuilds Tailwind through watched files; Vite's hot-update hook expects a module graph Rolldown does not provide.
- The app and routes are lazy chunks; a plugin pre-bundles the startup chain. Renaming or moving a startup route or the app entry silently drops it from that list.
- Rolldown's own watcher skips Vite's default `node_modules` ignore. Those files are pnpm-store hardlinks, so another worktree's install rebuilds every long-running server and leaks memory. Keep `node_modules` excluded.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts), [Tailwind plugin](../../apps/web/vite/tailwind.ts), and [startup warmup](../../apps/web/vite/warmBundledDev.ts).

`--share --built` skips the Vite dev server: it runs `vp build --watch` and the backend serves `apps/web/dist` on the same tailnet URL. Use it over slow links; there is no HMR (wait for the `built in` line, then reload), and the license manifest is not generated. It requires `--share` and `dev` mode.

### Reusable dev credential

Only use this on a hostname where you trust every service: browsers send cookies to all ports on a hostname, so any service there can receive the reusable admin credential. Generate one value once and put it in the main checkout's gitignored `.env`:

```sh
openssl rand -hex 32
# .env: IGLO_CODE_DEV_AUTH_TOKEN=<value>
```

The `iglo.code.json` Setup Worktree action links that file into each worktree. The dev runner reads repository env files at startup; `.env.local` and inherited process environment override `.env`. For a manual worktree, export the same fixed value instead; never generate a new one at startup. Restart `vp run dev --share` and open its printed pairing URL once per browser profile; later dev servers on the same hostname accept the shared cookie (30 days). The token and startup URLs are reusable admin secrets: never commit or publish them. Each server still seeds its own auth record and keeps its own SQLite data, signing key, and revocation state; non-dev servers ignore the value. See [environment auth](../internals/04_environment-auth.md#reusable-dev-credential).

## Checks

- `vp run check:changed` runs fast checks for your branch: format and lint of changed files, `knip:check` when code or a manifest changes, generated GraphQL checks, typecheck of affected packages and dependents, nearby tests, the agent context budget when the server is affected, and React Compiler coverage for changed web files. It maps files with [ci-changes.cjs](../../.github/scripts/ci-changes.cjs) and compares against the closest merge base with any remote's `main` (or a ref you pass). It skips full test suites and the build, so also run the pre-push checks below.
- Steps run in parallel, one per two cores and per 6 GiB of available memory (`--concurrency <n>` or `CHECK_CHANGED_CONCURRENCY`; `1` runs serially). A step past `--timeout <seconds>` or `CHECK_CHANGED_TIMEOUT` (default 900) is killed with its children and reported as `TIMEOUT`. With the exact files of the last passing run it prints that summary instead of rerunning.
- Focused iteration: `vp test run <files>`, `vp lint <files>`, `vp run --filter <pkg> typecheck`.
- `apps/web` tests that render React or touch the DOM are `*.browser.test.{ts,tsx}` and run in headless Chromium with the React Compiler on; other `*.test.ts` run in Node.
- Typechecking uses `effect-tsgo tsrs --noEmit` (`@effect/tsgo`); VS Code's TypeScript 7 extension starts the same checker through `.vscode/tsdk/tsgo` (`js/ts.tsdk.path`).

### Pre-push checks

This fork has no check CI. Before pushing to `main`, run locally:

```sh
vp fmt --check
vp run lint
vp run i18n:check
vp run --parallel --filter 't3...' --concurrency-limit 2 typecheck
vp test run packages/contracts/src/orchestrationV2.test.ts \
  packages/client-runtime/src/state/threadHistoryMerge.test.ts \
  apps/server/src/orchestration-v2/CommandPolicy.test.ts
vp run --filter t3 build
```

Also run focused tests for the changed behavior. `bun scripts/smoke-cli-archive.ts --source` checks source transport and persistence (or pass `--archive <path> --expect-version <version>` for an archive). `bun apps/server/scripts/web-client-regression.ts source` drives the real development client (or `archive <path> <version>` for the shipped one); both use disposable environments, and `T3_WEB_REGRESSION_BROWSER` points at the Chromium executable.

### Unused code

`vp run knip:check` checks unused files and dependencies repo-wide and unused runtime exports in `apps/server`, `apps/web`, and internal packages. Exported types and Effect schemas are allowed without consumers; functions that create or decode schemas stay checked. Canonical Effect service construction APIs stay exported with `@public`. Unused exports in `apps/web/src/components/ui/*.tsx` are ignored, an entirely unused file is not. `vp run knip --workspace apps/web` audits one workspace; `vp run knip:production --workspace apps/web` finds code kept alive only by tests. The full export audit still has findings and is not a repo-wide gate. Review callers before deleting; production mode can report development scripts and fixtures. Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).
