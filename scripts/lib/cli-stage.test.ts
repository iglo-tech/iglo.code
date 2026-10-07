import { describe, expect, it } from "vite-plus/test";
import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
} from "./cli-stage.ts";

describe("CLI archive stage", () => {
  it("selects file finder binaries for each supported platform", () => {
    expect(resolveFffNativeDependencies("mac", "arm64", "0.9.4")).toEqual({
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    expect(resolveFffNativeDependencies("win", "x64", "0.9.4")).toEqual({
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    expect(resolveFffNativeDependencies("linux", "arm64", "0.9.4")).toEqual({
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("installs native optional packages for the target rather than the build host", () => {
    expect(createStageWorkspaceConfig({ platform: "linux", arch: "arm64" })).toEqual({
      supportedArchitectures: { os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
    });
    expect(createStageWorkspaceConfig({ platform: "win", arch: "x64" })).toEqual({
      supportedArchitectures: { os: ["win32"], cpu: ["x64"] },
    });
  });

  it("keeps scoped and unscoped runtime patches without unused workspace patches", () => {
    const patches = createStagePatchedDependencies(
      {
        "@ff-labs/fff-node@0.9.4": "patches/fff.patch",
        "node-pty@1.2.0": "patches/pty.patch",
        "effect@4.0.1": "patches/effect.patch",
      },
      { "@ff-labs/fff-node": "0.9.4", "node-pty": "1.2.0" },
    );
    expect(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        patchedDependencies: patches,
        allowBuilds: { "node-pty": true },
        overrides: { "node-abi": "4.33.0" },
      }),
    ).toEqual({
      supportedArchitectures: { os: ["darwin"], cpu: ["arm64"] },
      patchedDependencies: {
        "@ff-labs/fff-node@0.9.4": "patches/fff.patch",
        "node-pty@1.2.0": "patches/pty.patch",
      },
      allowBuilds: { "node-pty": true },
      overrides: { "node-abi": "4.33.0" },
    });
  });
});
