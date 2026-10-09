---
name: sync-upstream
description: Import T3 Code upstream changes into iglo.code while preserving its web-only scope, Bun runtime, fork distribution, workflows, and lightweight CI. Use for upstream merges, snapshot imports, or removing restored desktop and mobile apps.
---

# Sync upstream into iglo.code

This fork ships the web client and server. The desktop and native mobile apps are
deliberately removed so agents cannot spend work customizing them. Keep shared
contracts, client runtime, server compatibility, CLI distribution, remote access,
and the Device panel. Testing a user's mobile project and using a mobile browser
are separate features from shipping T3 Code's native clients.

## Intentional fork differences

Treat these as preservation criteria for every import, including changes that
merge without conflicts. They describe behavior to retain; reconcile upstream
improvements at the affected boundary instead of freezing an old implementation.
Change a fork decision only when the maintainer requests it. Keep this list
current when an authorized change replaces a decision.

- **Identity and repository tooling.** Keep the iglo.code name, branding, README,
  repo-local skills, and fork-specific AGENTS.md guidance. Upstream attribution
  and compatible internal `t3` / `@t3tools` names remain valid.
- **Bun application runtime.** The server and first-party JavaScript helpers run
  on Bun. Preserve the minimum-version checks and align `.bun-version`,
  [bunRuntime.ts](../../../packages/shared/src/bunRuntime.ts), the server engine,
  dev/container setup, CI setup, and packaging when intentionally bumping Bun.
  Read the pin from the checkout; an upstream Node pin or older Bun pin must not
  downgrade it. Vite+/pnpm and their Node contributor toolchain remain separate
  from the installed application's runtime.
- **Standalone distribution.** Keep Bun executable archives and the packaged
  `runtime/bun` interpreter for helpers. Installed execution works without system
  Node, npm, or Bun. Preserve shared source/compiled self-invocation and service
  launch, update, checksum rejection, and rollback. The supported archive targets
  are macOS arm64, Linux x64, and Linux arm64; expanding them is a separate request.
  Keep native assets, disk-backed SDK/browser dependencies, web assets, resource
  monitoring, and signing. Packaging remains available for manual use through
  [CLI staging](../../../scripts/lib/cli-stage.ts) and
  [manual release procedures](../../../docs/operations/release.md).
- **Bun compatibility boundaries.** Retain working Node-compatible APIs and
  Effect services. Keep Bun PTY selection, SQLite boolean normalization, and
  supported stall diagnostics rather than restoring Node-only assumptions.
  Executable bundling preserves one shared Effect context, leaves `ws` to Bun's
  compatibility module, and stages file-backed dependencies using the same
  [external-package boundary](../../../scripts/lib/cli-external-packages.ts).
  [Event-loop monitoring](../../../apps/server/src/observability/EventLoopMonitor.ts)
  uses Bun histogram lateness and accounts for macOS sleep; stub utilization
  counters cannot gate warnings. Preserve focused runtime regression fixtures.
  Read [Bun runtime boundaries](../../../docs/internals/bun-runtime.md) when an
  import changes platform adapters; it records retained and inconclusive boundary decisions
  and the constraints behind the compatibility APIs.
- **Fork installation and updates.** Default release downloads and lookups stay
  on `iglo-tech/iglo.code`; npm launchers/packages stay under
  `@iglo-tech/iglo-code`. Keep explicit mirror overrides and channel matching.
  Server updates, service updates, install scripts, onboarding, and manual update
  commands must agree; none silently falls back to upstream. Sources are
  [release naming](../../../packages/shared/src/cliRelease.ts),
  [npm packaging](../../../scripts/build-npm-platform-packages.ts), and
  [the shared update action](../../../apps/web/src/components/ServerUpdateAction.tsx).
- **Device and remote features.** Retain the Device panel, local/SSH device hosts,
  `expo-device-hub`, `agent-device`, provider helpers, Browser streams, and
  local/remote/relay/tunnel connections. Device tool installation and execution
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
- **Lightweight CI.** `.github/workflows/ci.yml` is the only workflow, with one
  standard Ubuntu x64 job, branch-based cancellation, and the existing small
  smoke-test set. Keep its checks and use the repository Bun pin. Remove other
  imported workflows, including releases, deployments, previews, bots, Windows
  lanes, and runtime matrices. Retained packaging and runtime suites run manually;
  importing upstream is not a request to restore removed CI checks.

## Import upstream changes

For a removal-only request, skip importing and go straight to pruning.

Read the working tree status and the fork's README and AGENTS.md before importing.
Inspect the implementation of each fork difference touched by the incoming diff
and record its pre-import behavior in temporary notes outside the worktree.
Preserve local work and fork customizations. Fetch the configured `upstream` remote
and use the requested revision, or its default branch when none was specified.
Prefer an ordinary merge; desktop and mobile modify/delete conflicts are resolved
by deletion. Resolve shared-file conflicts by keeping upstream improvements and
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
python3 -B .agents/skills/sync-upstream/scripts/remove_native_apps.py
```

The helper needs only Python's standard library and can run before dependency
installation. It removes both app trees, their native tools, workflows, patches,
dependency configuration, and known workspace hooks. It rewrites known combined
desktop/CLI packaging integrations; apply the CI policy above to any remaining
workflows. It is safe to rerun. It drops obsolete native app lockfile importers
so pnpm can read the remaining catalog references; the package manager regenerates
the graph.

Audit newly imported integrations; the helper covers the known upstream layout.
Search for active hooks and contradictory guidance:

```sh
rg --hidden -n 'apps/(desktop|mobile)|@t3tools/(desktop|mobile)|dev:desktop|build:desktop|release-desktop|test-t3-mobile|mobile-native|mobile-showcase' \
  AGENTS.md README.md package.json pnpm-workspace.yaml vite.config.ts knip.jsonc \
  scripts .github .agents docs assets .devcontainer
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
python3 -B .agents/skills/sync-upstream/scripts/test_remove_native_apps.py
```

Review the final diff against the intentional fork differences, including files
that merged automatically. Confirm only the existing CI workflow/job/check scope
remains. For each affected difference, compare its behavior with the pre-import
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

Finish when both native apps and their active hooks are absent, the lockfile
matches the remaining workspace, and fork customizations survive. Report the
imported upstream revision (when applicable), checks, affected fork differences
preserved, and unresolved conflicts.
Commit, push, and PR creation follow the user's request and repository instructions.
