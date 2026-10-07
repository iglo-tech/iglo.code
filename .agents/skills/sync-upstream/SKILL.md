---
name: sync-upstream
description: Bring T3 Code upstream changes into iglo.code while preserving fork customizations and removing the native mobile app. Use for upstream merges, pulls, snapshot imports, or reapplying the fork's web and desktop scope.
---

# Sync upstream into iglo.code

This fork ships web and desktop. The native mobile app is deliberately removed so
agents cannot spend work customizing it. Keep shared contracts, client runtime,
server compatibility, remote access, and the Device panel: testing a user's mobile
project is a separate feature from shipping T3 Code's mobile client.

## Import upstream changes

For a removal-only request, skip importing and go straight to pruning.

Read the working tree status and the fork's README and AGENTS.md before importing.
Preserve local work and fork customizations. Fetch the configured `upstream` remote
and use the requested revision, or its default branch when none was specified.
Prefer an ordinary merge; mobile modify/delete conflicts are resolved by deletion.
Resolve shared-file conflicts by keeping upstream improvements and reapplying the
fork's changes, rather than choosing one entire side.

Git history is optional for this fork. When a snapshot import makes an update
simpler, stage upstream in a temporary directory and compare it with the fork
before copying. Preserve fork additions and customizations, including this skill,
README, and the fork scope in AGENTS.md. Account for upstream deletions as well as
additions. Keep `.git`, dependencies, generated output, credentials, and T3 state
outside the copy. A snapshot is an alternative import method, not permission to
overwrite unrelated local work.

## Reapply the fork scope

From the repository root, run:

```sh
python3 .agents/skills/sync-upstream/scripts/remove_mobile.py
```

The helper needs only Python's standard library and can run before dependency
installation. It removes the mobile tree, native tooling, mobile workflows,
mobile-only patches and dependency configuration, and known workspace hooks.
It is safe to rerun. It drops obsolete mobile lockfile importers so pnpm can read
the remaining catalog references; the package manager regenerates the graph.

Audit the imported changes for newly introduced mobile hooks; the helper handles
the known layout, not every possible future upstream layout. Search with:

```sh
rg --hidden -n 'apps/mobile|@t3tools/mobile|test-t3-mobile|mobile-native|mobile-showcase' \
  AGENTS.md package.json pnpm-workspace.yaml vite.config.ts knip.jsonc \
  scripts .github .agents docs assets

rg --hidden -n '\bmobile\b|\bAndroid\b|\biOS\b' \
  AGENTS.md README.md docs packages/client-runtime/README.md .cursor
```

Occurrences inside this skill, generic path-parsing fixtures, and old upstream
examples can be valid. Remove active imports, build/release tasks, config entries,
broken links, and instructions that ask agents to implement or test the removed
app. Adapt the helper when upstream introduces a new mobile-only integration.
Keep the fork scope prominent in AGENTS.md and remove contradictory mobile
development guidance. Retain shared implementation code even if its upstream
comments mention mobile; rewriting it adds future conflicts without helping the
fork's scope. Review native-client guidance in user docs as well as developer
instructions; preserve guidance about mobile browsers and users' device projects.

Regenerate `pnpm-lock.yaml` with `vp i --lockfile-only --ignore-scripts` after
pruning, then install with `vp i --frozen-lockfile`. Do not hand-edit the dependency
graph or upgrade unrelated versions. The workspace must contain no mobile app
importer or mobile-only build configuration. Preserve dependencies used by the
remaining workspace: `@legendapp/list` also ships the web list and can bring
native peer packages into the lockfile. The Device panel's independently managed
`expo-device-hub` tool remains supported.

## Verify the result

Run the helper again and confirm it reports no changes. Run its focused tests:

```sh
python3 -B .agents/skills/sync-upstream/scripts/test_remove_mobile.py
```

Check the affected tooling with targeted lint, package typechecks, and tests.
In particular, exercise release-smoke and license tooling if upstream changed
their mobile hooks. Follow AGENTS.md for verification scope and browser consent.
Finish when the native app and its active hooks are absent, the lockfile matches
the remaining workspace, and fork customizations survive. Report the imported
upstream revision (when applicable), checks, and any unresolved conflicts. Commit,
push, and PR creation follow the user's request and repository instructions.
