# Intentional fork differences

Treat these as preservation criteria for every import, including changes that
merge without conflicts. They describe behavior to retain; reconcile upstream
improvements at the affected boundary instead of freezing an old implementation.
Change a fork decision only when the maintainer requests it. Keep this list
current when an authorized change replaces a decision.

- **Identity and repository tooling.** Keep the iglo.code name, branding, README,
  repo-local skills, and fork-specific AGENTS.md guidance. User-facing, CLI,
  server, i18n, and agent-facing product copy uses `iglo.code` rather than
  `T3 Code` (enforced repo-wide by `check-fork-identity.ts`, with explicit
  attribution exceptions only). The igloo icon set
  (`assets/iglo`, `apps/web/public` favicons, 192/512 px app icons, and
  `manifest.webmanifest`) replaces upstream's T3 icons; keep the installable web
  app's manifest entries. Upstream attribution
  and internal code names that never leave the process (`@t3tools/*` packages,
  the `t3` workspace package, TypeScript identifiers, source file names) remain
  valid; renaming them only causes merge conflicts.
- **No GitHub star prompt.** Upstream's "Enjoying T3 Code? Give us a star"
  popup (`apps/web/src/components/GitHubStarPrompt.*`), its composer send hook
  in `useComposerSend.ts`, and the web `canvas-confetti` dependencies are
  removed and pruned in `fork-scope.ts`.
- **TypeScript on Bun only.** Repository tooling, including these sync helpers, is
  TypeScript run with Bun. The fork keeps no Python: imports drop upstream `.py`
  files and the identity check fails on any tracked one. Port a needed upstream
  script rather than restoring it.
- **No website.** Keep upstream's `apps/marketing` (the t3.codes site) removed
  with its scripts, lockfile importer, and lint, knip, and gitignore entries.
- **Side-by-side runtime identity.** iglo.code and an installed T3 Code must run on
  one machine at once without reading each other's state at runtime, whatever
  the user's config. The one sanctioned crossing is the user-run
  `iglo.code import`: a one-time, refusal-first import of a stopped T3 Code
  home into a clean iglo.code home (`cli/importT3.ts`, renumbering T3 Code's
  migration ledger through
  `persistence/reconcileUpstreamMigrationLedger.ts`). It never opens the T3
  Code database directly — it works from a private staged copy and snapshots
  that, so nothing is written back — but after an import iglo.code does manage
  the old home's `worktrees` directory in place (recorded via
  `previousWorktreesDirectories`) and links its `scratch` folder to the old
  home's. The import depends on the migration divergence below:
  `FORK_ONLY_MIGRATIONS` in
  `persistence/reconcileUpstreamMigrationLedger.ts` lists every fork-only
  migration (`59_ScheduledTaskDelivery`, `60_ScheduleDispatchTargets`,
  `105_PeerLinkSessionBinding`) so the upstream id mapping is derived from
  `migrationManifest` by name. New upstream migrations need no change there,
  but any new or renumbered fork-only migration must be registered in
  `FORK_ONLY_MIGRATIONS` (prefer avoiding new interleaved fork-only
  migrations whenever possible). Every name that
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
- **No mobile app pairing link.** `iglo.code pair` and headless startup output
  (`cli/pair.ts`, `startupAccess.ts`) print the pairing URL, token, and a QR
  code of the pairing URL, never upstream's `App link: t3code://pair?…` line
  for the removed mobile app. Keep `buildPairingAppLink` out of
  `packages/shared/src/remote.ts`; `readPairingAppLink` may stay for imported
  dormant desktop code.
- **Local development.** The maintainer uses the local toolchain. Keep
  `.devcontainer/` and its numbered internals/operations docs removed, along with their
  configuration and documentation references. Upstream's pruned numbered docs
  (`docs/internals/00_*`, `docs/operations/00_*`) carry the fork's decisions; mobile,
  devcontainer, Connect-setup, and relay-observability docs stay removed.
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
  `darwin-x64`; keep the fork's installer and archive builder accepting it.
  [release-local.ts](../../../scripts/release-local.ts) publishes only
  `darwin-arm64` and `linux-x64`.
  Keep native assets, disk-backed SDK/browser dependencies, web assets, resource
  monitoring, and signing. Packaging remains available for manual use through
  [CLI staging](../../../scripts/lib/cli-stage.ts) and
  [manual release procedures](../../../docs/operations/03_release.md).
- **Bun compatibility boundaries.** Retain working Node-compatible APIs and
  Effect services. Keep Bun PTY selection, SQLite boolean normalization, and
  supported stall diagnostics rather than restoring Node-only assumptions.
  Keep upstream's Node-only `cliCompileCache` removed: Bun has no `node:sea`, so
  importing it stops the CLI at startup, and Bun's `enableCompileCache` is a stub.
  Keep upstream's `--max-old-space-size` and its child-heap test out of
  [DocumentText](../../../apps/server/src/provider/DocumentText.ts): Bun ignores
  the flag and JSC options cannot cap the heap, so the worker's own limits bound it.
  Bun carries no `AsyncLocalStorage` store into module evaluation, so
  [WorkflowRuntime](../../../apps/server/src/workflows/WorkflowRuntime.ts) keeps its
  `evaluatingUnderBun` fallback for the load in progress; without it every
  `T3.workflow(…)` call in a definition file fails. Upstream's benchmarks (`scripts/metrics`: Node/V8-inspector server, web and
  mobile) stay removed: they build on the removed e2e scenarios and Playwright.
  Upstream's Linux `ProcessLauncher` (`process/ProcessLauncher.ts`, now Effect's
  `NodeChildProcessProxy`, with its `__process-launcher` dispatch in `bin.ts` and its
  `processRunner.test.ts` cases) stays removed and the server keeps `NonBlockingSpawner`: it works around libuv forking the
  whole Node server per spawn and hands pipes back over Node IPC; Bun spawns without that fork.
  Upstream code that asks the launcher for its PID (such as PortScanner's and ProviderProcesses' launcher-child checks)
  stays out with it: agent CLIs are direct children of the server here.
  Upstream's `NodePtyAdapter` and its node-pty tests stay pruned in `fork-scope.ts`; terminals
  spawn through `BunPtyAdapter`.
  Server tests run under `bun --bun`; the `vitest@5.1.1` patch makes Vitest's watchdog skip
  the IPC channel `unref()` Bun lacks, without which every forks worker fails to start. Move it
  to each Vitest bump or drop it once Vitest guards the call.
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
  `iglo-tech/iglo.code`, built and published locally per
  [releases](../../../docs/operations/03_release.md). The fork publishes nothing to npm: drop imported npm launcher,
  `npx`/`bunx` install, and npm-based server update paths. Keep explicit mirror
  overrides and channel matching. Server updates, service updates, install
  scripts, onboarding, and manual update commands must agree; none silently
  falls back to upstream. Sources are
  [release naming](../../../packages/shared/src/cliRelease.ts) and
  [the shared update action](../../../apps/web/src/components/ServerUpdateAction.tsx).
  With no desktop updater, the web client stands in for it: the sidebar update
  pill and Settings → About check the primary server's `server.release` on its
  own track (on mount, every few minutes, and on click), feed a newer release to
  Update everything as the servers' target, and offer Reload once the server
  runs ahead of the page. See [appRelease.ts](../../../apps/web/src/state/appRelease.ts);
  keep the web branches when upstream changes the desktop update UI.
  A UI update supersedes a deferred local install (`iglo.code update` that
  skipped the restart): the service launcher starts the trial from the running
  server instead of rejecting with "Service selection changed", and the commit
  clears `.restart-pending`. See `#selectUpdate` in
  [serviceLauncher.ts](../../../apps/server/src/serviceLauncher.ts).
- **Device and remote features.** Retain the Device panel, local/SSH device hosts,
  `expo-device-hub`, `agent-device`, provider helpers, Browser streams, and
  local, LAN, Tailscale, and SSH connections. Device tool installation and execution
  use the supported Bun interpreter, including remote version checks; removing
  native T3 clients must not remove users' device-project support.
- **Headed full-Chrome browser pane.** The pane and HTML renders share one pinned
  full Chrome for Testing (`chrome` flavor, never upstream's
  `chrome-headless-shell`), installed under `tools/chrome/<platform>/<version>`
  with per-platform executable paths and the macOS bundle's symlinks; see
  [PreviewBrowser.ts](../../../apps/server/src/preview/PreviewBrowser.ts).
  Upstream pins and bumps the shell: port a bump as a full-Chrome re-pin with
  fresh sizes and SHA-256 from the Chrome for Testing index, not by restoring the
  shell release table, its `tools/chrome-headless-shell` install root, or the
  UA-spoofing `presentAsChrome` path this fork deleted. The pane always launches
  headed (`headless: false` in
  [ServerBrowserContexts.ts](../../../apps/server/src/preview/ServerBrowserContexts.ts));
  there is no headless fallback, and persistent contexts keep one blank anchor
  page open instead of closing all initial pages so headed Chrome does not exit
  on Linux and Windows before `newPage()` runs. A Linux host without a display gets one from
  [XvfbServer.ts](../../../apps/server/src/preview/XvfbServer.ts), started on
  demand and closed with the server; a missing Xvfb is a hard
  `PreviewBrowserDisplayError`. `iglo.code browser setup` owns the host story: it
  installs Xvfb, the fuller full-Chrome library list, and the `t3-chrome`
  AppArmor profile, unloading the legacy `t3-chrome-headless-shell` profile. The
  error reaches clients through the fork-only `"display"` value of
  `PreviewStreamHostSetup.need`; keep that literal, its
  [ServerBrowserStream.ts](../../../apps/server/src/preview/ServerBrowserStream.ts)
  mapping, and the client decode in
  [serverBrowserStream.ts](../../../packages/client-runtime/src/preview/serverBrowserStream.ts)
  together when importing upstream contracts, which has only `"sandbox"` and
  `"libraries"`.
- **Peer links are two-way.** Upstream links one direction per sign-in; the fork
  makes one link serve both. After the forward sign-in, the linking environment
  mints its own one-time peer-link code and offers it over
  `/api/peer-links/reciprocal`, and the peer links back at the same access with
  the code the offer carried; **Forget** removes the link on both sides and ends
  both sessions when the peer answers. Every first-party caller
  sends `reciprocal: true` (there is no one-way opt-out; unset on the wire still
  means one way for older clients). Every link is full access:
  the access choice (picker, `--access`, the `t3_environment_link` access
  parameter) is removed and the server ignores any access a caller sends (the client
  RPC inputs keep an optional `access` that clients still send, because an older
  server requires it), while
  an accepted reciprocal offer and stored rows keep an older peer's lower access. The offered link-back addresses
  are MagicDNS names probed to answer as this server, even when Serve was
  published by `pair --tailscale` rather than the service, and the CLI reads the
  running server's bind and port from its runtime state; that self-probe waits
  out a Serve certificate being issued (`TAILNET_NAME_PROBE_TIMEOUT` in
  [DirectEndpoints.ts](../../../apps/server/src/environment/DirectEndpoints.ts)).
  Links are re-checked: `PeerLinks.check` calls `/api/peer-links/origins` with the
  link's token on a timer (PeerLinkKeepAlive), from **Check now** (`peerLinks.check`
  RPC), `iglo.code environment check` and a re-link of a held machine, records or
  clears `last_error`, and trades both sides' current addresses. Devices follow links: the web client connects itself to every machine its
  connected machines link to, through the one-step link pairing
  ([LinkedEnvironmentsAutoConnect](../../../apps/web/src/components/LinkedEnvironmentsAutoConnect.tsx)),
  and drops the ones it joined that way when the link goes. Upstream's one-way pieces stay
  intact underneath, so reconcile at their boundaries rather than freezing:
  [PeerLinks.ts](../../../apps/server/src/peer/PeerLinks.ts) (offer, accept,
  teardown hop),
  [peerLinksHttp.ts](../../../apps/server/src/peer/peerLinksHttp.ts) and the
  `peerLinks` group with its `PeerLinkAuthenticated` middleware
  ([environmentHttp.ts](../../../packages/contracts/src/environmentHttp.ts)),
  [OwnLinkOrigins.ts](../../../apps/server/src/peer/OwnLinkOrigins.ts) (addresses
  a peer can reach back: tailnet entries only — plain-http LAN and loopback are
  refused by the peer's own address rules), the `peerLinkReciprocal` capability,
  the `reciprocal` fields in
  [peerLink.ts](../../../packages/contracts/src/peerLink.ts) and the link
  request answer, and the results (`PeerLinkCreateResult`, `PeerLinkRemoveResult.remote`)
  in [rpc.ts](../../../packages/contracts/src/rpc.ts). Preserve the bindings that
  keep offers and teardowns honest — the declared id rides the OAuth
  registration as a bounded `software_version`, signed into the session
  (`peid` in [SessionStore.ts](../../../apps/server/src/auth/SessionStore.ts)
  through [McpOAuth.ts](../../../apps/server/src/auth/McpOAuth.ts) and
  [EnvironmentAuth.ts](../../../apps/server/src/auth/EnvironmentAuth.ts)), but
  it is only a claim: the accept path refuses to move an existing link row
  whatever address the offer carries, and each row's `peer_session_id` (migration 105) names the one session that may forget it — bound to the offering
  session on accept, and to the back-link session found via the spent grant's
  `pairing_grant_id` on the offering side. An impostor session therefore pays
  with its own revocation and cannot touch an existing row — but it can still
  register a new row under an id this side has not linked yet, since the id is
  its own claim; that is the trust boundary (you gave that machine a pairing
  code). The create result is flat with an
  optional `reciprocal` so mixed versions decode it, and unset `reciprocal` on
  the wire means one way. The accepting link passes `reciprocal: false` so
  offers never loop, a failed offer revokes its one-time code, and each teardown
  hop fires only when a row was removed, so the hops stop. Web: the outcome notices in
  [LinkedEnvironmentsSettings.tsx](../../../apps/web/src/components/settings/LinkedEnvironmentsSettings.tsx)
  and [LinkRequestCard.tsx](../../../apps/web/src/components/chat/LinkRequestCard.tsx),
  the answer field in
  [linkRequest.ts](../../../packages/client-runtime/src/linkRequest.ts), and the
  testkit's served peers with links
  ([PeerLinks.testkit.ts](../../../apps/server/src/peer/PeerLinks.testkit.ts)).
  Drop this entry wholesale once upstream ships its own two-way linking and the
  fork moves onto it.
- **Peer links keep themselves alive.** Upstream renews a link's 30-day session
  only when traffic crosses it, so an idle link expires. The fork pings each
  unexpired link it holds over MCP once a day (and at startup), which renews it
  on the peer and records the new expiry here:
  [PeerLinkKeepAlive.ts](../../../apps/server/src/peer/PeerLinkKeepAlive.ts) and
  `keepAlive` in
  [PeerMcpClient.ts](../../../apps/server/src/peer/PeerMcpClient.ts), wired in
  `server.ts` beside the other peer layers. Keep it when upstream changes link
  renewal, unless upstream adds its own keepalive or a setting that removes the
  idle expiry.
- **Provider skills and automation delivery.** Preserve fresh workspace-scoped
  skill discovery and explicit invocation availability in the composer; see
  [providerSkills.ts](../../../packages/client-runtime/src/providerSkills.ts).
  Recurring thread automations keep one outstanding automatic check through
  usage limits or paused queues, while explicit Run now requests remain distinct.
  Retain original queued prompts and truthful queued/dispatched delivery status;
  see [recurring automations](../../../docs/user/project-settings.md#recurring-automations).
- **No CI.** The fork has no GitHub workflows: release archives are built and
  published locally per [releases](../../../docs/operations/03_release.md). The
  pruning helper deletes every file in `.github/workflows` on each import,
  including upstream's `release.yml` and `ci.yml`. Checks run locally before pushing:
  `vp fmt --check`, `vp run lint`, `vp run i18n:check`,
  `vp run --parallel --filter 't3...' --concurrency-limit 2 typecheck`, the smoke tests in
  [development checks](../../../docs/operations/00_development.md#pre-push-checks), and
  `vp run --filter t3 build`. Importing upstream is not a request to restore CI.
  When upstream changes archive building, reconcile it into the local release steps.
  `.github/scripts/ci-changes.cjs` stays because `vp run check:changed` uses it. Upstream's
  shared Vite task cache (`infra/task-cache`, `.task-cache.json`, and its root
  `vite.config.ts` hooks) targets upstream's own Cloudflare worker; keep it removed.
  Upstream's e2e scenarios (`scripts/scenarios`, `scripts/e2e.config.ts`,
  `prove-scenario`, and the `e2e`/`@e2e-dev/*` dependencies) drive the iOS
  simulator alongside the web client; they stay removed with their docs.
- **Sidebar layout.** The sidebar has no top bar: no brand name, no Electron
  history arrows, no stage artwork, and no Version pill (the Appearance setting
  offers artwork or None; artwork still tints the send button). The floating
  sidebar toggle renders only while the sidebar is hidden; on phones the sheet's
  close button sits at the top of the rail. Upstream edits to
  `SidebarChromeHeader`, `SidebarBrandWidthProbe`, or the brand-measured minimum
  width do not come back. The rest of the sidebar keeps these decisions:
  - **Project rail.** A 56px (`w-14`) Discord-style rail
    ([SidebarProjectSwitcher.tsx](../../../apps/web/src/components/sidebar/SidebarProjectSwitcher.tsx))
    replaces upstream's project filter combobox. Click switches the scope,
    Shift-click toggles multi-selection, right-click opens the project menu. The
    edge pill is short for an unread finish, medium on hover, and tall when
    selected; the list has no scrollbar gutter so pills sit flush. A red count
    badges threads that need input or failed, and a blue dot marks running work
    ([resolveSidebarProjectActivity](../../../apps/web/src/components/Sidebar.logic.ts)).
    Buttons are tinted with the project icon's colour, not a grey fill. Upstream's
    combobox pieces (`ProjectComboboxRow.tsx`, `filterSidebarProjectScopeItems`,
    `reduceSidebarProjectScopeMenuState`) stay removed.
  - **New thread.** The header is the search field with a ghost pencil icon beside
    it, with no Add project or filter buttons (adding lives in the rail). A
    one-project rail scope starts the thread there, preferring the open thread's
    environment member; All projects always opens the picker, even with one open
    project (upstream starts in that project). The button and the `chat.new`
    shortcut share `resolveNewThreadTarget`.
  - **Scheduled.** A collapsible Scheduled section below Working lists the scoped
    projects' scheduled tasks, soonest first; a row opens the task's own page
    (`/scheduled/$environmentId/$taskId`, `ScheduledTaskPage`) in the main pane with
    the editor inline, not a dialog. The section is one `scheduled-header` marker
    block that holds its own rows, so upstream changes to the sidebar markers or drag
    projection must keep it
    ([SidebarScheduledShelf.tsx](../../../apps/web/src/components/sidebar/SidebarScheduledShelf.tsx)).
- **Idle background work stops.** Background commands an agent left running stop
  after a set idle time (Settings > Threads, `idleBackgroundWorkStopAfterMinutes`),
  with inferred waits, pinned threads, and open parents exempt, and the chat
  offers **Turn it back on**
  ([IdleBackgroundWork.ts](../../../apps/server/src/orchestration-v2/IdleBackgroundWork.ts)).
  Upstream has no equivalent yet (its issue 35223); reconcile if it ships one.
- **Worktree cleanup saves work and clears agent leftovers.** In
  [storageCleanup.ts](../../../apps/server/src/storageCleanup.ts), the
  `save-changes` keep-when value ("Nothing, save changes first") commits a due
  worktree's edits and untracked files under `refs/iglo.code-saved/` and then
  force-removes it. Only age, settling and deletion save edits; the merged and
  unchanged rules, task folders, submodules and paused merges or rebases still
  keep them. A linked worktree no thread uses (upstream only reports these) whose
  repository is one of the server's projects is removed once its last Git
  activity passes that project's inactive retention, under the same keep-when
  rule, unless a detached HEAD holds commits on no branch. Fork defaults
  step 3 turns on `save-changes` with 2 inactive and 1 settled day.
  `scripts/release-local.ts` deletes its build folders and prunes Docker
  leftovers after publishing.
- **History swipe setting.** The fork carries upstream PR 28370's
  `historySwipeNavigation` setting (off by default). Drop the fork copy once
  upstream merges its own.
- **Mistral Vibe usage provider.** The fork carries upstream PR 23380's `mistral`
  usage provider (Mistral Vibe session stats and estimated cost in the Usage
  view), which upstream closed unmerged. Drop the fork copy once upstream
  merges its own; reconcile the reader, the driver/provider lists, and the web
  presentations together.
- **Antigravity usage limits.** Upstream removed the Antigravity limits reader in #43026
  because it called Google's internal quota APIs, which Google said can flag an account.
  The fork reads them through the CLI instead: `antigravityUsageLimits.ts` runs
  `agy -p /usage` against the instance's profile (`readUsage` in `AntigravityDriver.ts`
  gives it a home whose `.gemini` links to that profile) and parses the printed rows, at
  most every 5 minutes. The CLI refreshes its own sign-in. Readings pool across machines
  by the signed-in Google e-mail. Hub Antigravity accounts stay unread, as upstream.
  Keep this on later syncs; without it no machine shows Antigravity limits.
- **Streamed limits replace an external usage link.** A provider that publishes only a
  usage link (managed ChatGPT Codex, whose token the usage endpoint refuses) still
  streams `account/rateLimits/updated` during turns. Upstream drops those because the
  limits are `unsupported`; the fork lets them replace the link and keeps them across
  link-only health checks (`linkOnly` in `provider-core/src/server/usageLimits.ts`).
  The link card reads "Used by {provider} on {environment}".

- **Move a thread between projects.** A thread's context menu (sidebar row and
  chat header share one builder) offers **Move to project** with a destination
  submenu: project identity (a custom monogram icon, else the title monogram)
  and a short path, rendered through `ContextMenuItem.monogram`. The guarded
  `threads.moveToProject` method re-points the thread's scheduled tasks and
  dispatches the internal `thread.project.move` command
  ([ThreadProjectMove.ts](../../../apps/server/src/project/ThreadProjectMove.ts);
  `dispatchThreadProjectMove` in
  [Orchestrator.ts](../../../apps/server/src/orchestration-v2/Orchestrator.ts)).
  A move detaches live provider sessions ("Moved to another project.") exactly
  as a workspace change does, refuses while work or background agents run or
  the target is archived or deleted, and clears the worktree pin plus the old
  repository's branch and pull request links — including the `pullRequests`
  array the UI reads first — so the thread re-homes clean at the target
  project's root. The undo notice ("Moved") moves it back and restores a
  worktree thread's pin, branch, and pull request links through
  `thread.metadata.update` (which carries an optional wholesale-replace
  `pullRequests` field for that restore)
  ([useThreadActions.ts](../../../apps/web/src/hooks/useThreadActions.ts)).
  The `threadProjectMove` server capability hides the item on older servers.
  Keep the destinations builder and menu item in
  [threadActionMenu.logic.ts](../../../apps/web/src/components/threadActionMenu.logic.ts),
  the **Move a thread between projects** section in
  [thread-sidebar.md](../../../docs/user/thread-sidebar.md), and the focused
  tests beside each layer (runtimeLayer.test.ts, useThreadActions.undo.test.ts,
  threadActionMenu.logic.test.ts, commandPermissions.test.ts). Upstream has no
  equivalent yet; if it ships its own move, reconcile the contracts, menu, and
  dispatch semantics rather than carrying both paths.
- **Versioned fork server defaults.** `FORK_SERVER_DEFAULTS_STEPS` in
  [contracts forkSettingsDefaults.ts](../../../packages/contracts/src/forkSettingsDefaults.ts)
  holds iglo.code's server defaults (step 2 turns on `autoResumeLimitedThreads`,
  so limited threads always continue at their reset). Never edit or renumber a shipped step;
  append a higher version. The server wraps `ServerSettings.layer` with
  `withForkSettingsDefaults` from
  [forkSettingsDefaults.ts](../../../apps/server/src/forkSettingsDefaults.ts) in
  [server.ts](../../../apps/server/src/server.ts), which applies each pending
  step once through `updateSettings` and records it in
  `<stateDir>/fork-defaults-version` (the marker alone decides; deleting it
  re-applies every step). Locked managed-policy paths are skipped and a corrupt
  `settings.json` stays untouched. `DEFAULT_SERVER_SETTINGS`,
  [serverSettings.ts](../../../apps/server/src/serverSettings.ts), and the
  schema defaults stay upstream: `settings.json` is stored sparse against
  them and missing keys decode to them, so changing them would silently flip
  stored choices. Settings resets to the fork values instead:
  `DEFAULT_UNIFIED_SETTINGS` in
  [settings.ts](../../../packages/contracts/src/settings.ts) spreads
  `withForkServerDefaults(DEFAULT_SERVER_SETTINGS)`, and the workspace,
  automatic pull, and branch naming resets read it instead of hard-coded
  values. The inheritance popover still compares against upstream defaults,
  since it describes what the server stores. Preserve
  [forkSettingsDefaults.test.ts](../../../apps/server/src/forkSettingsDefaults.test.ts),
  which pins the Settings values to what the server applies.
  Per-browser client settings have their own steps, `FORK_CLIENT_DEFAULTS_STEPS`
  in the same contracts file (step 1 queues follow-ups instead of steering).
  [clientPersistenceStorage.ts](../../../apps/web/src/clientPersistenceStorage.ts)
  applies pending steps once to the saved settings and records them in the
  `iglo-code:fork-client-defaults-version` localStorage key. Client settings
  are saved whole rather than sparse, so `DEFAULT_CLIENT_SETTINGS` does include
  the steps: a browser with nothing saved starts from them, and Settings resets
  to them. Same rule: never edit or renumber a shipped step.
