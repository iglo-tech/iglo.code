---
name: sync-upstream
description: Import T3 Code upstream changes into iglo.code while preserving its web-only scope, Bun runtime, fork distribution, plugin workflows, and local-only checks. Use for upstream merges, snapshot imports, or removing restored desktop/mobile apps and devcontainer setup.
---

# Sync upstream into iglo.code

This fork ships the web client and server. The desktop and native mobile apps are
deliberately removed so agents cannot spend work customizing them. Keep shared
contracts, client runtime, server compatibility, CLI distribution, remote access
over LAN, Tailscale, and SSH, and the Device panel. iglo.code runs side by side
with an installed T3 Code, so every import must keep its runtime identity apart. Testing a user's mobile project and using a mobile browser
are separate features from shipping T3 Code's native clients.

## Intentional fork differences

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
  release, and many merge without conflicts. Run the identity check below after
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

## Import upstream changes

For a removal-only request, skip importing and go straight to pruning.

Read the working tree status and the fork's README and AGENTS.md before importing.
Inspect the implementation of each fork difference touched by the incoming diff
and record its pre-import behavior in temporary notes outside the worktree.
Preserve local work and fork customizations. Fetch the configured `upstream` remote
and use the requested revision, or its default branch when none was specified.
Merge a filtered upstream commit rather than upstream itself:

```sh
filtered=$(bun .agents/skills/sync-upstream/scripts/filter-upstream.ts upstream/main)
git merge --no-ff -m "Merge upstream $(git rev-parse --short upstream/main)" "$filtered"
```

The filtered commit is upstream's tree minus every path in
[fork-scope.ts](scripts/fork-scope.ts) (native apps, website, relay, check CI,
npm launcher, Python files, and dependency patches for removed apps), with the upstream commit
as its parent. Upstream history and later merge bases are unchanged, while
removed paths never produce modify/delete conflicts or come back as new files.
The script lists any other upstream edit to a file the fork deleted; decide each
one, and add the path to `fork-scope.ts` when the removal is permanent. Do not
list a file the fork renamed or moved: Git's rename detection carries upstream
edits into it only while the original stays in the merge.
Resolve shared-file conflicts by keeping upstream improvements and
reapplying the fork's changes, rather than choosing one entire side.

Git history is optional for this fork. When a snapshot import makes an update
simpler, stage upstream in a temporary directory and compare it with the fork
before copying. Preserve fork additions and customizations, including this skill,
the intentional differences above, README, and the fork scope in AGENTS.md.
Account for upstream deletions as well as additions. Keep `.git`, dependencies,
generated output, credentials, and T3 state outside the copy. A snapshot is an
alternative import method, not permission to overwrite unrelated local work.

Keep pull requests pointed at the fork. Verify `origin` is `iglo-tech/iglo.code`,
then run `gh repo set-default origin` and check `gh repo set-default --view`.
GitHub CLI otherwise prefers the `upstream` remote, while the app can submit a
branch name pushed only to `origin`, causing `head invalid`. This setting lives in
local Git configuration and must be reapplied in fresh clones; snapshot imports
must preserve it with `.git`. Continue fetching `upstream` explicitly for updates.

## Reapply the fork scope

From the repository root, run:

```sh
bun .agents/skills/sync-upstream/scripts/remove-native-apps.ts
```

The helper uses only Bun and Node built-ins and can run before dependency
installation. It removes both app trees, `apps/marketing`, the devcontainer and its guide, native tools, workflows, patches,
dependency configuration, and known workspace hooks. It rewrites known combined
desktop/CLI packaging integrations; apply the CI policy above to any remaining
workflows. It is safe to rerun. It drops obsolete native app lockfile importers
so pnpm can read the remaining catalog references; the package manager regenerates
the graph.

Whole files and directories to delete live in `fork-scope.ts`, which both the
helper and the filtered import read; the helper keeps the edits to shared files.
Audit newly imported integrations; the helper covers the known upstream layout.
Search for active hooks and contradictory guidance:

```sh
rg --hidden -n 'apps/(desktop|mobile|marketing)|@t3tools/(desktop|mobile|marketing)|dev:desktop|build:desktop|release-desktop|test-t3-mobile|mobile-native|mobile-showcase' \
  AGENTS.md README.md package.json pnpm-workspace.yaml vite.config.ts knip.jsonc \
  scripts .github .agents docs assets
git grep -inE 'devcontainer|codespace|containerEnv|remoteContainers' -- ':!.repos/**'
```

Occurrences inside this skill, path fixtures, and upstream compatibility code can
be valid. Remove active imports of deleted files, build/release tasks, config
entries, broken links, and instructions to implement or test the removed apps.
Adapt the helper when upstream adds a native-only integration. Keep the web-only
scope prominent in AGENTS.md and review user and developer guidance.

Desktop packaging can contain helpers also used by the server release. Move those
into CLI tooling before deleting their desktop module. Reconcile upstream
improvements with the standalone distribution above; the pruning helper only
rewrites known imports and does not preserve all fork customizations automatically.
Retain shared implementation code even if it includes desktop/mobile adapters or
comments. Preserve remote access, mobile browsers, and users' device projects.

Regenerate `pnpm-lock.yaml` with `vp i --lockfile-only --ignore-scripts` after
pruning, then install with `vp i --frozen-lockfile`. If `vp` is absent, use the
repository's pinned pnpm version for installation. Do not hand-edit the dependency
graph or upgrade unrelated versions. The workspace must contain no desktop or
mobile app importer or native-app build configuration. Preserve dependencies
used by the remaining workspace: `@clerk/electron` is imported by web sign-in,
and `@legendapp/list` ships the web list and can bring native peer packages into
the lockfile. The Device panel's independently managed `expo-device-hub` remains
supported.

## Verify the result

Run the helper again and confirm it reports no changes. Run its focused tests:

```sh
bun test ./.agents/skills/sync-upstream/scripts/sync-upstream.test.ts
```

Run the identity check and rename every hit it reports, following the naming
table above. Explain anything you allow instead of renaming in the check's
allowlist:

```sh
bun .agents/skills/sync-upstream/scripts/check-fork-identity.ts
```

Review the final diff against the intentional fork differences, including files
that merged automatically. Confirm `.github/workflows` holds only
`iglo-release.yml`, and that docs added by upstream do not reintroduce the
desktop or mobile apps, T3 Connect, npm installs, or `t3` command names. For each affected difference, compare its behavior with the pre-import
notes and run the smallest relevant proof. Changes to runtime launch, helper
execution, or packaging need source and actual standalone archive smoke checks;
a source-only pass cannot prove packaged helper execution or bundled dependency
boundaries. Preserve the focused tests and fixtures that exercise those paths.

Check affected tooling with targeted lint, package typechecks, and tests. Exercise
release-smoke and CLI staging when packaging changes, and keep artifact names and
paths aligned across manual build, installation, and update tools. Bun version or
performance-sensitive changes also need fresh startup, idle CPU, and memory
measurements under comparable source/built forms; distinguish RSS from platform
footprint and avoid treating one sample or forced GC as normal memory usage.
Follow AGENTS.md for verification scope and browser consent.

Finish when both native apps, the devcontainer, and their active hooks are absent, the lockfile
matches the remaining workspace, the identity check passes, and fork customizations survive. Report the
imported upstream revision (when applicable), checks, affected fork differences
preserved, and unresolved conflicts.
Commit, push, and PR creation follow the user's request and repository instructions.
