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

[fork-differences.md](fork-differences.md) lists the features and fixes iglo.code
keeps apart from upstream. Read it before every import: it is the preservation
criteria for each change, including changes that merge without conflicts, and it
holds the runtime naming table. Keep it current when the maintainer authorizes a
change to a fork decision.

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
the intentional differences in
[fork-differences.md](fork-differences.md), README, and the fork scope in AGENTS.md.
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
desktop/CLI packaging integrations; apply the release-only CI policy in
[fork-differences.md](fork-differences.md) to any remaining
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
improvements with the standalone distribution in
[fork-differences.md](fork-differences.md); the pruning helper only
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
table in [fork-differences.md](fork-differences.md). Explain anything you allow instead of renaming in the check's
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
