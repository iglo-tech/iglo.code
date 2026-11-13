# Intentional fork differences

Treat these as preservation criteria for every import, including changes that
merge without conflicts. They describe behavior to retain; reconcile upstream
improvements at the affected boundary instead of freezing an old implementation.
Change a fork decision only when the maintainer requests it. Keep this list
current when an authorized change replaces a decision.

- **Identity and repository tooling.** Keep the iglo.code name, branding, README,
  repo-local skills, and fork-specific AGENTS.md guidance. Upstream attribution
  and internal code names that never leave the process (`@t3tools/*` packages,
  the `t3` workspace package, TypeScript identifiers, source file names) remain
  valid; renaming them only causes merge conflicts.
- **TypeScript on Bun only.** Repository tooling, including these sync helpers, is
  TypeScript run with Bun. The fork keeps no Python: imports drop upstream `.py`
  files and the identity check fails on any tracked one. Port a needed upstream
  script rather than restoring it.
- **No website.** Keep upstream's `apps/marketing` (the t3.codes site) removed
  with its scripts, lockfile importer, and lint, knip, and gitignore entries.
- **Side-by-side runtime identity.** iglo.code and an installed T3 Code must run on
  one machine at once without reading each other's state, whatever the user's
  config. No data migration from T3 Code exists or is wanted. Every name that
  reaches disk, the environment, git, the network, or an agent stays renamed:

  | Upstream                                              | iglo.code                                                          |
  | ----------------------------------------------------- | ------------------------------------------------------------------ |
  | `t3` CLI binary, archive `t3-<ver>-<target>.tar.gz`   | `iglo.code`, `iglo.code-<ver>-<target>.tar.gz`                     |
  | `~/.t3`, worktree `.t3`                               | `~/.iglo.code`, worktree `.iglo.code`                              |
  | `T3CODE_*` and runtime `T3_*` variables               | `IGLO_CODE_*` (test-only mock-agent knobs such as `T3_ACP_*` stay) |
  | default port `3773`                                   | `4773`                                                             |
  | `com.t3tools.t3code.service`, `t3code.service`        | `code.iglo.service`, `iglo.code.service`                           |
  | `refs/t3/…`, `refs/t3code/…`                          | `refs/iglo.code/…`                                                 |
  | `t3_session`, `t3_dev_session_*` cookies              | `iglo_code_session`, `iglo_code_dev_session_*`                     |
  | `t3-code` / `t3_code` MCP server and client names     | `iglo-code`                                                        |
  | `t3.json` project file                                | `iglo.code.json` (`t3.json` is never read)                         |
  | `t3-resource-monitor`, `t3code-server` telemetry name | `iglo-code-resource-monitor`, `iglo-code-server`                   |

  Upstream adds new variables, paths, refs, and agent-facing names with every
  release, and many merge without conflicts. Run the identity check in [SKILL.md](SKILL.md#verify-the-result) after
  every import and rename what it reports; the table is the naming rule for new
  names too.

- **T3 Connect disabled.** The fork does not use T3 Connect, its relay, Clerk
  sign-in, or the hosted `app.t3.codes` client. Keep it unreachable: no settings
  entry, no `up` option, no relay connection at server start, no relay deploys.
  Imported Connect code may stay dormant; do not re-enable an entry point. The
  switch is `hasCloudPublicConfig = false` in the server and web
  `cloud/publicConfig.ts`, which read no env var or build define; keep upstream's
  relay/Clerk defines out of the Vite configs, and keep `infra/relay`, its catalog
  entries, and its patches removed.
- **Local development.** The maintainer uses the local toolchain. Keep
  `.devcontainer/` and `docs/internals/devcontainer.md` removed, along with their
  configuration and documentation references.
- **Bun application runtime.** The server and first-party JavaScript helpers run
  on Bun. Preserve the minimum-version checks and align `.bun-version`,
  [bunRuntime.ts](../../../packages/shared/src/bunRuntime.ts), the server engine,
  dev setup, CI setup, and packaging when intentionally bumping Bun.
  Read the pin from the checkout; an upstream Node pin or older Bun pin must not
  downgrade it. Vite+/pnpm and their Node contributor toolchain remain separate
  from the installed application's runtime.
- **Standalone distribution.** Keep Bun executable archives and the packaged
  `runtime/bun` interpreter for helpers. Installed execution works without system
  Node, npm, or Bun. Preserve shared source/compiled self-invocation and service
  launch, update, checksum rejection, and rollback. The supported archive targets
  are macOS arm64, macOS x64 (Intel), Linux x64, and Linux arm64. Upstream excludes
  `darwin-x64`; keep the fork's installer, archive builder, and release matrix
  accepting it.
  Keep native assets, disk-backed SDK/browser dependencies, web assets, resource
  monitoring, and signing. Packaging remains available for manual use through
  [CLI staging](../../../scripts/lib/cli-stage.ts) and
  [manual release procedures](../../../docs/operations/release.md).
- **Bun compatibility boundaries.** Retain working Node-compatible APIs and
  Effect services. Keep Bun PTY selection, SQLite boolean normalization, and
  supported stall diagnostics rather than restoring Node-only assumptions.
  Keep upstream's Node-only `cliCompileCache` removed: Bun has no `node:sea`, so
  importing it stops the CLI at startup, and Bun's `enableCompileCache` is a stub.
  Executable bundling preserves one shared Effect context, leaves `ws` to Bun's
  compatibility module, and stages file-backed dependencies using the same
  [external-package boundary](../../../scripts/lib/cli-external-packages.ts).
  [Event-loop monitoring](../../../apps/server/src/observability/EventLoopMonitor.ts)
  uses Bun histogram lateness and accounts for macOS sleep; stub utilization
  counters cannot gate warnings. Preserve focused runtime regression fixtures.
  Read [Bun runtime boundaries](../../../docs/internals/bun-runtime.md) when an
  import changes platform adapters; it records retained and inconclusive boundary decisions
  and the constraints behind the compatibility APIs.
- **Fork installation and updates.** Releases are GitHub Release assets on
  `iglo-tech/iglo.code`, built and published by `.github/workflows/iglo-release.yml`
  on a `v*` tag. The fork publishes nothing to npm: drop imported npm launcher,
  `npx`/`bunx` install, and npm-based server update paths. Keep explicit mirror
  overrides and channel matching. Server updates, service updates, install
  scripts, onboarding, and manual update commands must agree; none silently
  falls back to upstream. Sources are
  [release naming](../../../packages/shared/src/cliRelease.ts) and
  [the shared update action](../../../apps/web/src/components/ServerUpdateAction.tsx).
- **Device and remote features.** Retain the Device panel, local/SSH device hosts,
  `expo-device-hub`, `agent-device`, provider helpers, Browser streams, and
  local, LAN, Tailscale, and SSH connections. Device tool installation and execution
  use the supported Bun interpreter, including remote version checks; removing
  native T3 clients must not remove users' device-project support.
- **Plugin and workflow extensions.** Preserve the fork's compiled plugin host,
  Reports fixture, and [workflow plugin](../../../packages/plugin-workflows/src/server.ts),
  including provider/model/skill choices, parallel reviews, bounded rework,
  human decisions, and durable recovery. Reconcile their contracts, migrations,
  permission scopes, MCP tools, scheduler integration, and client contributions
  together. Preserve private plugin state and independently built client/server
  compatibility. The boundary and recovery constraints live in
  [plugins.md](../../../docs/internals/plugins.md).
- **Provider skills and automation delivery.** Preserve fresh workspace-scoped
  skill discovery and explicit invocation availability in the composer; see
  [providerSkills.ts](../../../packages/client-runtime/src/providerSkills.ts).
  Recurring thread automations keep one outstanding automatic check through
  usage limits or paused queues, while explicit Run now requests remain distinct.
  Retain original queued prompts and truthful queued/dispatched delivery status;
  see [recurring automations](../../../docs/user/project-settings.md#recurring-automations).
- **Release-only CI.** The fork's one workflow, `iglo-release.yml`, builds and
  publishes release archives; it runs no checks. The pruning helper deletes every
  other file in `.github/workflows` on each import, including upstream's
  `release.yml` and `ci.yml`. Checks run locally before pushing:
  `vp fmt --check`, `vp run lint`,
  `vp run --parallel --filter 't3...' --concurrency-limit 2 typecheck`, the smoke tests in
  [development checks](../../../docs/operations/development.md#checks), and
  `vp run --filter t3 build`. Importing upstream is not a request to restore check CI.
  When upstream changes archive building, reconcile it into `iglo-release.yml`.
  `.github/scripts/ci-changes.cjs` stays because `vp run check:changed` uses it. Upstream's
  shared Vite task cache (`infra/task-cache`, `.task-cache.json`, and its root
  `vite.config.ts` hooks) targets upstream's own Cloudflare worker; keep it removed.
  Upstream's e2e scenarios (`scripts/scenarios`, `scripts/e2e.config.ts`,
  `prove-scenario`, and the `e2e`/`@e2e-dev/*` dependencies) drive the iOS
  simulator alongside the web client; they stay removed with their docs.
