// @effect-diagnostics nodeBuiltinImport:off -- The HTTP upgrade runs in an actual Bun child, independently of the test framework runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, test } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

test("Bun Browser stream upgrades and delivers the controlled host-setup close frame", () => {
  const child = NodeChildProcess.spawnSync(
    process.env.BUN_EXECUTABLE ?? "bun",
    [NodeURL.fileURLToPath(new URL("testing/browserStreamRuntime.fixture.ts", import.meta.url))],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("valid host-setup WebSocket close under Bun");
});

test("CLI-bundled Bun Browser stream completes the close handshake without HTTP bytes", () => {
  const repoRoot = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
  const fixture = NodeURL.fileURLToPath(
    new URL("testing/browserStreamRuntime.fixture.ts", import.meta.url),
  );
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-browser-wire-"));
  const successful = (child: ReturnType<typeof NodeChildProcess.spawnSync>) => {
    expect(child.error).toBeUndefined();
    expect(child.status, `${child.stdout ?? ""}${child.stderr ?? ""}`).toBe(0);
    return String(child.stdout ?? "");
  };
  try {
    const bun = successful(
      NodeChildProcess.spawnSync(process.env.BUN_EXECUTABLE ?? "bun", ["-p", "process.execPath"], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    ).trim();
    NodeFS.writeFileSync(
      NodePath.join(scratch, "package.json"),
      JSON.stringify({ name: "browser-wire-fixture", private: true, type: "module" }),
    );
    NodeFS.symlinkSync(
      NodePath.join(repoRoot, "apps/server/node_modules"),
      NodePath.join(scratch, "node_modules"),
      "junction",
    );
    NodeFS.writeFileSync(
      NodePath.join(scratch, "vite.config.ts"),
      `
import { defineConfig } from ${JSON.stringify(NodePath.join(repoRoot, "node_modules/vite-plus/dist/index.js"))};
import { isExternalCliDependency, shouldBundleCliDependency } from ${JSON.stringify(NodePath.join(repoRoot, "scripts/lib/cli-external-packages.ts"))};
export default defineConfig({pack: {
  entry: [${JSON.stringify(fixture)}], outDir: ${JSON.stringify(NodePath.join(scratch, "dist"))},
  deps: {alwaysBundle: shouldBundleCliDependency, neverBundle: isExternalCliDependency, onlyBundle: false},
}});
`,
    );
    successful(
      NodeChildProcess.spawnSync(NodePath.join(repoRoot, "node_modules/.bin/vp"), ["pack"], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 30_000,
      }),
    );
    const executable = NodePath.join(scratch, "browser-wire");
    successful(
      NodeChildProcess.spawnSync(
        bun,
        [
          "build",
          NodePath.join(scratch, "dist/browserStreamRuntime.fixture.mjs"),
          "--compile",
          "--compile-autoload-package-json",
          "--outfile",
          executable,
        ],
        { encoding: "utf8", timeout: 30_000 },
      ),
    );
    if (HostProcessPlatform.defaultValue() === "darwin")
      successful(
        NodeChildProcess.spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", executable], {
          encoding: "utf8",
          timeout: 10_000,
        }),
      );
    const output = successful(
      NodeChildProcess.spawnSync(executable, [], {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: "", BUN_EXECUTABLE: bun },
      }),
    );
    expect(output).toContain("valid host-setup WebSocket close under Bun");
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
