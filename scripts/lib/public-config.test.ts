// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "IGLO_CODE_EXAMPLE=root\nIGLO_CODE_ROOT_ONLY=root\n",
    );
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.local"), "IGLO_CODE_EXAMPLE=local\n");

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toMatchObject({
      IGLO_CODE_EXAMPLE: "local",
      IGLO_CODE_ROOT_ONLY: "root",
    });
    expect(
      loadRepoEnv({ baseEnv: { IGLO_CODE_EXAMPLE: "process" }, repoRoot }).IGLO_CODE_EXAMPLE,
    ).toBe("process");
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
