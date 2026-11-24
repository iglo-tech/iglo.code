# Releases and deployments

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork has no CI: checks and release builds run locally. Nothing is published to npm, and
tags do not deploy web previews or production.

## Publish a release

Run the [pre-push checks](./00_development.md#pre-push-checks). Set the version in the package
manifests and commit it, then build, smoke-test, and publish from the release host:

```sh
version=1.2.3
bun scripts/update-release-package-versions.ts "$version"
git commit -am "chore(release): v$version" && git push origin HEAD:main
git tag "v$version" && git push origin "v$version"
export IGLO_CODE_TELEMETRY_CHANNEL=stable VITE_RELEASE_CHANNEL=stable
# Build and smoke-test this host's archive (see the next section), then:
bun apps/server/scripts/cli.ts release-manifest --version "$version" --output-dir release-cli
(cd release-cli && shasum -a 256 iglo.code-"$version"-*.tar.gz release.json > SHA256SUMS)
gh release create "v$version" release-cli/iglo.code-"$version"-*.tar.gz release-cli/release.json \
  release-cli/SHA256SUMS --verify-tag --title "iglo.code v$version" --generate-notes --latest
```

A release carries an archive only for each host it was built on. The installer and
`iglo.code update` fail on a platform whose archive is missing, so build on every platform you
run before publishing, or attach the extra archive later with `gh release upload` and regenerate
`SHA256SUMS` over every archive.

The tag picks the channel, matching [release naming](../../packages/shared/src/cliRelease.ts):

| Tag                         | Channel | Release flags            |
| --------------------------- | ------- | ------------------------ |
| `vX.Y.Z`                    | stable  | latest                   |
| `vX.Y.Z-nightly.YYYYMMDD.N` | nightly | prerelease, never latest |
| `vX.Y.Z-preview.YYYYMMDD.N` | preview | prerelease, never latest |

The installer resolves stable through `/releases/latest`, and nightly or preview by listing
releases, so a stable release must be the latest one. Publish nightly and preview tags with
`--prerelease --latest=false` and the matching telemetry channel. `iglo.code update` lists
releases newest first and skips drafts.

macOS archives are signed ad hoc unless `IGLO_CODE_CLI_MAC_SIGN_IDENTITY` names a Developer ID
Application identity in the keychain. `curl` does not quarantine downloads, so ad hoc signing is
enough for the installer.

## Build a standalone archive by hand

Build on the archive's target host. For example, on Linux x64:

```sh
vp i --frozen-lockfile
vp run --filter t3 build
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p apps/server/dist/resource-monitor/linux-x64
cp native/resource-monitor/target/release/iglo-code-resource-monitor apps/server/dist/resource-monitor/linux-x64/
bun apps/server/scripts/cli.ts build-exe --target linux-x64
version=$(bun -p "require('./apps/server/package.json').version")
bun scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" --output-dir release-cli
bun scripts/smoke-cli-archive.ts --archive "release-cli/iglo.code-$version-linux-x64.tar.gz" --expect-version "$version"
```

Use the pinned Bun version in `.bun-version`; `vp` must be on PATH, since archive packaging runs
`vp install`. The archive carries the web client, native assets, disk-backed SDK dependencies,
and a pinned interpreter at `runtime/bun` for helper scripts, so installed execution needs no
system Node, npm, or Bun. Installers and updates download from `iglo-tech/iglo.code` and never
fall back to upstream. An explicit `IGLO_CODE_RELEASE_BASE_URL` can point at a mirror laid out
like GitHub's release downloads.

## Server self-update release invariant

Connected servers update to the client's exact version, not to the newest release. Servers that
update themselves download that version's archive from the GitHub Release; others are shown an
installer command pinned to it (`IGLO_CODE_VERSION=<version>`). A client served by one server can
ask another connected environment to update, so every version's release archives must be
published before that version's server serves its client. Otherwise the **Update server** action
targets a release that does not exist yet.

For a release smoke test, connect the new client to a server on the previous version and verify
that the update action reconnects to the matching server. When the release adds database
migrations, verify that the remote update applies them and reconnects. A failed trial must
restore the database snapshot and restart the previous server. If the installed launcher does
not support the target protocol, verify that the update stops before restart and run
`iglo.code service update` once on the server machine. Also test the manual update guidance when
those environments are available.
