#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A maintainer script that only shells out to git, docker and gh.
/**
 * Builds the release archives on this Apple Silicon Mac (darwin-arm64 natively, linux-x64 in an
 * x64 Docker container) and publishes them, with release.json and SHA256SUMS, as the GitHub
 * Release that scripts/install.sh and `iglo.code update` read.
 *
 *   bun scripts/release-local.ts v1.2.3 [--build-only] [--work-dir <dir>]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const REPOSITORY = "iglo-tech/iglo.code";
const LINUX_IMAGE = "iglo-code-release-linux-x64";

interface Target {
  readonly key: "darwin-arm64" | "linux-x64";
  readonly platform: "mac" | "linux";
  readonly arch: "arm64" | "x64";
}

const TARGETS: ReadonlyArray<Target> = [
  { key: "darwin-arm64", platform: "mac", arch: "arm64" },
  { key: "linux-x64", platform: "linux", arch: "x64" },
];

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

function fail(message: string): never {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; input?: string; logFile?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const log = options.logFile ? NodeFS.createWriteStream(options.logFile, { flags: "a" }) : null;
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      log?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (log) log.write(chunk);
      else process.stderr.write(chunk);
    });
    child.stdin.end(options.input ?? "");
    child.on("error", reject);
    child.on("close", (code) => {
      log?.end();
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function resolveRelease(tag: string) {
  const version = tag.replace(/^v/, "");
  if (!tag.startsWith("v")) fail(`Release tags start with v; got '${tag}'.`);
  // Stable must be plain X.Y.Z: the installer finds it through /releases/latest.
  if (/^\d+\.\d+\.\d+$/.test(version)) return { version, channel: "stable" as const };
  const prerelease = /^\d+\.\d+\.\d+-(nightly|preview)\.\d{8}\.\d+$/.exec(version);
  if (prerelease) return { version, channel: prerelease[1] as "nightly" | "preview" };
  return fail(`'${tag}' is neither vX.Y.Z nor vX.Y.Z-(nightly|preview).YYYYMMDD.N.`);
}

/** The same steps for every target, run from a clean export of the tag. */
function buildScript(target: Target, version: string): string {
  const monitorDir = `apps/server/dist/resource-monitor/${target.key}`;
  const archive = `release-cli/iglo.code-${version}-${target.key}.tar.gz`;
  return [
    "set -euo pipefail",
    'export PATH="$PWD/node_modules/.bin:$PATH"',
    "pnpm install --frozen-lockfile",
    // Nightly and preview tags are cut without a version commit; the binary reports the tag.
    `bun scripts/update-release-package-versions.ts "${version}"`,
    "vp run --filter t3 build",
    "cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml",
    `mkdir -p "${monitorDir}"`,
    `cp native/resource-monitor/target/release/iglo-code-resource-monitor "${monitorDir}/"`,
    `bun apps/server/scripts/cli.ts build-exe --target ${target.key}`,
    `bun scripts/build-cli-archive.ts --platform ${target.platform} --arch ${target.arch} --version "${version}" --output-dir release-cli`,
    `bun scripts/smoke-cli-archive.ts --archive "${archive}" --expect-version "${version}"`,
    `bun apps/server/scripts/cli.ts release-manifest --version "${version}" --output-dir release-cli`,
  ].join("\n");
}

function linuxDockerfile(nodeVersion: string, bunVersion: string, pnpmSpec: string): string {
  return [
    `FROM node:${nodeVersion}-bookworm`,
    "RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*",
    `RUN npm install --global "${pnpmSpec}"`,
    `RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${bunVersion}"`,
    "ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH",
    "RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal",
  ].join("\n");
}

async function buildTarget(target: Target, source: string, version: string, channel: string) {
  const logFile = NodePath.join(NodePath.dirname(source), `${target.key}.log`);
  const script = buildScript(target, version);
  const env = {
    IGLO_CODE_TELEMETRY_CHANNEL: channel,
    VITE_RELEASE_CHANNEL: channel,
  };
  console.log(`[release] Building ${target.key} (log: ${logFile})`);
  try {
    if (target.platform === "mac") {
      await run("bash", ["-c", script], { cwd: source, logFile, env: { ...process.env, ...env } });
    } else {
      await run(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/amd64",
          "-v",
          `${source}:/src`,
          "-v",
          "iglo-code-release-pnpm-store:/root/.local/share/pnpm",
          "-v",
          "iglo-code-release-cargo-registry:/usr/local/cargo/registry",
          "-w",
          "/src",
          ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
          LINUX_IMAGE,
          "bash",
          "-c",
          script,
        ],
        { logFile },
      );
    }
  } catch (error) {
    const tail = NodeFS.readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n");
    throw new Error(`${target.key} failed:\n${tail}`, { cause: error });
  }
  console.log(`[release] Built ${target.key}`);
}

async function main() {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      "build-only": { type: "boolean", default: false },
      "work-dir": { type: "string" },
    },
  });
  const tag = positionals[0] ?? fail("Usage: bun scripts/release-local.ts <tag> [--build-only]");
  const { version, channel } = resolveRelease(tag);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone release tooling has no Effect runtime.
  if (NodeOS.platform() !== "darwin" || NodeOS.arch() !== "arm64") {
    fail("Run releases on an Apple Silicon Mac; darwin-arm64 builds natively.");
  }
  const workDir = NodePath.resolve(
    values["work-dir"] ?? NodePath.join(NodeOS.homedir(), "Library/Caches/iglo.code-release", tag),
  );
  const env = { ...process.env, GH_REPO: REPOSITORY };

  await run("git", ["fetch", "--quiet", "origin", "tag", tag]);
  const remoteTag = await run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
  if (!remoteTag.trim()) fail(`Push ${tag} to origin first.`);
  if (!values["build-only"]) {
    const existing = await run("gh", ["release", "view", tag, "--json", "isDraft"], { env }).catch(
      () => null,
    );
    if (existing) fail(`${tag} already has a GitHub Release; delete it to publish again.`);
  }

  const packageJson = JSON.parse(await run("git", ["show", `${tag}:package.json`])) as {
    packageManager: string;
    engines: { node: string };
  };
  const bunVersion = (await run("git", ["show", `${tag}:.bun-version`])).trim();

  NodeFS.rmSync(workDir, { recursive: true, force: true });
  NodeFS.mkdirSync(workDir, { recursive: true });
  console.log(`[release] ${tag} on the ${channel} channel, building in ${workDir}`);

  // Each target gets its own export: node_modules and native builds differ per platform.
  const sources = new Map<Target["key"], string>();
  for (const target of TARGETS) {
    const source = NodePath.join(workDir, target.key);
    NodeFS.mkdirSync(source);
    await run("bash", ["-c", `git archive --format=tar "${tag}" | tar -x -C "${source}"`]);
    sources.set(target.key, source);
  }

  console.log(`[release] Preparing the ${LINUX_IMAGE} Docker image`);
  await run("docker", ["build", "--quiet", "--platform", "linux/amd64", "-t", LINUX_IMAGE, "-"], {
    input: linuxDockerfile(packageJson.engines.node, bunVersion, packageJson.packageManager),
  });

  await Promise.all(
    TARGETS.map((target) => buildTarget(target, sources.get(target.key)!, version, channel)),
  );

  const assetsDir = NodePath.join(workDir, "assets");
  NodeFS.mkdirSync(assetsDir);
  const assets: Array<string> = [];
  for (const target of TARGETS) {
    const name = `iglo.code-${version}-${target.key}.tar.gz`;
    NodeFS.copyFileSync(
      NodePath.join(sources.get(target.key)!, "release-cli", name),
      NodePath.join(assetsDir, name),
    );
    assets.push(name);
  }
  // Every target builds the same migrations, so one writes the manifest track switches read.
  NodeFS.copyFileSync(
    NodePath.join(sources.get("linux-x64")!, "release-cli", "release.json"),
    NodePath.join(assetsDir, "release.json"),
  );
  assets.push("release.json");
  const checksums = assets
    .map((name) => {
      const hash = NodeCrypto.createHash("sha256");
      hash.update(NodeFS.readFileSync(NodePath.join(assetsDir, name)));
      return `${hash.digest("hex")}  ${name}\n`;
    })
    .join("");
  NodeFS.writeFileSync(NodePath.join(assetsDir, "SHA256SUMS"), checksums);
  assets.push("SHA256SUMS");
  console.log(checksums.trimEnd());

  if (values["build-only"]) {
    console.log(`[release] Built ${tag} into ${assetsDir}; not published (--build-only).`);
    return;
  }

  // Drafts are invisible to the installer and updater, so publishing after every upload means
  // no client ever sees a release with missing assets. Only stable becomes "latest".
  const channelFlags = channel === "stable" ? ["--latest"] : ["--prerelease", "--latest=false"];
  await run(
    "gh",
    [
      "release",
      "create",
      tag,
      ...assets.map((name) => NodePath.join(assetsDir, name)),
      "--verify-tag",
      "--draft",
      "--title",
      `iglo.code ${tag}`,
      "--generate-notes",
      ...channelFlags,
    ],
    { env },
  );
  await run("gh", ["release", "edit", tag, "--draft=false", ...channelFlags], { env });
  console.log(`[release] Published https://github.com/${REPOSITORY}/releases/tag/${tag}`);
}

await main();
