---
name: sync-upstream
description: Import T3 Code upstream changes into iglo.code while preserving fork customizations and its web-only scope. Use for upstream merges, snapshot imports, or removing restored desktop and mobile apps.
---

# Sync upstream into iglo.code

This fork ships the web client and server. The desktop and native mobile apps are
deliberately removed so agents cannot spend work customizing them. Keep shared
contracts, client runtime, server compatibility, CLI distribution, remote access,
and the Device panel. Testing a user's mobile project and using a mobile browser
are separate features from shipping T3 Code's native clients.

## Import upstream changes

For a removal-only request, skip importing and go straight to pruning.

Read the working tree status and the fork's README and AGENTS.md before importing.
Preserve local work and fork customizations. Fetch the configured `upstream` remote
and use the requested revision, or its default branch when none was specified.
Prefer an ordinary merge; desktop and mobile modify/delete conflicts are resolved
by deletion. Resolve shared-file conflicts by keeping upstream improvements and
reapplying the fork's changes, rather than choosing one entire side.

Git history is optional for this fork. When a snapshot import makes an update
simpler, stage upstream in a temporary directory and compare it with the fork
before copying. Preserve fork additions and customizations, including this skill,
the CLI packaging helpers and workflow, README, and the fork scope in AGENTS.md.
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
dependency configuration, and known workspace hooks. It also converts upstream's
combined desktop/CLI release jobs to CLI-only builds. It is safe to rerun. It
drops obsolete native app lockfile importers so pnpm can read the remaining
catalog references; the package manager regenerates the graph.

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

Desktop packaging can contain helpers or jobs also used by the server release.
Move shared helpers into CLI tooling before deleting their desktop module; retain
the standalone archives, npm packages, signing, resource monitor, and web build.
The fork keeps these helpers in `scripts/lib/cli-stage.ts` and the platform jobs
in `.github/workflows/release-cli.yml`. Reconcile upstream improvements to those
paths when packaging changes; the pruning helper only rewrites known imports.
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

Check affected tooling with targeted lint, package typechecks, and tests. Exercise
release-smoke and CLI staging when packaging changes. Verify that release job
dependencies, reusable-workflow inputs, and artifact paths still agree. Follow
AGENTS.md for verification scope and browser consent.

Finish when both native apps and their active hooks are absent, the lockfile
matches the remaining workspace, and fork customizations survive. Report the
imported upstream revision (when applicable), checks, and unresolved conflicts.
Commit, push, and PR creation follow the user's request and repository instructions.
