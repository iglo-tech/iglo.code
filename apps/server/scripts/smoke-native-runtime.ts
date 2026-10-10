#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off -- This external runner owns temporary native fixtures and child processes.
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { BUN_VERSION } from "@t3tools/shared/bunRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const platform = await Effect.runPromise(HostProcess.Platform);
const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const [requestedMode = "source", archive, ...extra] = process.argv.slice(2);
const mode = requestedMode.replace(/^--/u, "");
NodeAssert.strict.ok(
  extra.length === 0 &&
    ((mode === "source" && archive === undefined) || (mode === "archive" && archive)),
  "Usage: bun apps/server/scripts/smoke-native-runtime.ts source | archive <archive.tar.gz>",
);
NodeAssert.strict.equal(
  (await exec(process.execPath, ["-p", "process.versions.bun ?? ''"])).stdout.trim(),
  BUN_VERSION,
);
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "iglo-native-bun-smoke-"));
try {
  let root = scratch;
  let bun = process.execPath;
  let application = NodePath.resolve(scriptDirectory, "../src/bin.ts");
  if (mode === "archive") {
    await exec("/usr/bin/tar", ["-xzf", NodePath.resolve(archive!), "-C", scratch]);
    const entries = await NodeFSP.readdir(scratch);
    NodeAssert.strict.equal(entries.length, 1, "The archive must contain one install root");
    root = NodePath.join(scratch, entries[0]!);
    bun = NodePath.join(root, "runtime/bun");
    application = NodePath.join(root, "t3");
  } else {
    await NodeFSP.symlink(
      NodePath.resolve(scriptDirectory, "../node_modules"),
      NodePath.join(root, "node_modules"),
    );
  }
  const fixture = NodePath.join(
    root,
    mode === "archive" ? "native-runtime-smoke" : "native-runtime-smoke.mjs",
  );
  await exec(
    process.execPath,
    [
      "build",
      NodePath.join(scriptDirectory, "native-fixtures/runtime.ts"),
      ...(mode === "archive" ? ["--compile", "--compile-autoload-package-json"] : []),
      "--target=bun",
      "--packages=bundle",
      "--external=@ff-labs/*",
      "--external=@napi-rs/keyring*",
      "--outfile",
      fixture,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  if (mode === "archive" && platform === "darwin") {
    await exec("/usr/bin/codesign", ["--force", "--sign", "-", fixture]);
  }
  const bin = NodePath.join(scratch, "bin");
  const home = NodePath.join(scratch, "home");
  const workspace = NodePath.join(scratch, "workspace");
  await Promise.all([NodeFSP.mkdir(bin), NodeFSP.mkdir(home), NodeFSP.mkdir(workspace)]);
  // The PTY shell needs one OS utility. No Node, npm, npx or system Bun is visible.
  const stty = (await exec("/bin/sh", ["-c", "command -v stty"])).stdout.trim();
  await NodeFSP.symlink(stty, NodePath.join(bin, "stty"));
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    TMPDIR: scratch,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    T3_NATIVE_SMOKE_APPLICATION: application,
    T3_NATIVE_SMOKE_COMPILED: String(mode === "archive"),
    T3_NATIVE_SMOKE_WORKSPACE: workspace,
  };
  for (const command of ["node", "npm", "npx", "bun"]) {
    await NodeAssert.strict.rejects(exec(command, ["--version"], { cwd: root, env }));
  }
  NodeAssert.strict.equal(
    (await exec(bun, ["-p", "process.versions.bun ?? ''"], { cwd: root, env })).stdout.trim(),
    BUN_VERSION,
  );
  const result = await exec(
    mode === "archive" ? fixture : bun,
    mode === "archive" ? [] : [fixture],
    {
      cwd: root,
      env,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await NodeFSP.rm(scratch, { recursive: true, force: true });
}
