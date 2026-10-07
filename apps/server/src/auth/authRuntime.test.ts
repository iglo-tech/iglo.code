// @effect-diagnostics nodeBuiltinImport:off -- Exercises auth under the actual Bun runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";

it("pairs and persists browser and scoped OAuth sessions under actual Bun", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bun-auth-"));
  try {
    const child = NodeChildProcess.spawnSync(
      process.env.T3_BUN_EXECUTABLE ?? "bun",
      [NodeURL.fileURLToPath(new URL("./testing/authRuntime.fixture.ts", import.meta.url)), home],
      { encoding: "utf8", timeout: 15_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("paired and persisted browser and scoped OAuth sessions\n");
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
