// @effect-diagnostics nodeBuiltinImport:off -- The HTTP upgrade runs in an actual Bun child, independently of the test framework runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { expect, test } from "@effect/vitest";

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
