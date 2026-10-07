// @effect-diagnostics nodeBuiltinImport:off -- Exercises actual Bun subprocesses outside the test runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "./hostProcess.ts";
import { resolveBunExecutable, resolveSelfInvocation, selfInvocationArgs } from "./bunRuntime.ts";
import { symlinksSupported } from "./testing/symlinks.ts";

const bunExecutable =
  process.env.T3_BUN_EXECUTABLE ??
  NodeChildProcess.execFileSync("which", ["bun"], { encoding: "utf8" }).trim();

describe("Self invocation", () => {
  it.effect("runs the entrypoint script with the current runtime", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const invocation = yield* resolveSelfInvocation().pipe(
        Effect.provideService(HostProcessExecutablePath, "/runtime/bun"),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(HostProcessArguments, ["/runtime/bun", "dist/bin.mjs", "serve"]),
      );
      expect(invocation.command).toBe("/runtime/bun");
      expect(invocation.entrypoint).toBe(path.resolve("dist/bin.mjs"));
      expect(selfInvocationArgs(invocation, ["acp-mcp-bridge"])).toEqual([
        path.resolve("dist/bin.mjs"),
        "acp-mcp-bridge",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes subcommands straight to the standalone executable", () =>
    Effect.gen(function* () {
      // Bun points argv[1] at its embedded virtual filesystem entrypoint.
      const invocation = yield* resolveSelfInvocation().pipe(
        Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessArguments, ["bun", "/$bunfs/root/t3", "serve"]),
      );
      expect(invocation).toEqual({ command: "/packaged/t3", entrypoint: undefined });
      expect(selfInvocationArgs(invocation, ["acp-mcp-bridge"])).toEqual(["acp-mcp-bridge"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Bun helper runtime selection", () => {
  it.effect("keeps the current Bun runtime without requiring Bun on PATH", () =>
    Effect.gen(function* () {
      for (const executable of ["/runtime/bun"]) {
        expect(
          yield* resolveBunExecutable("Local device support", { PATH: "" }).pipe(
            Effect.provideService(HostProcessExecutablePath, executable),
            Effect.provideService(HostProcessIsExecutable, false),
          ),
        ).toBe(executable);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses installed Bun instead of the standalone T3 executable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        yield* resolveBunExecutable("Local device support", {
          PATH: path.dirname(bunExecutable),
        }),
      ).toBe(bunExecutable);
    }).pipe(
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("explains how to install Bun when a standalone helper has no Bun interpreter", () =>
    Effect.gen(function* () {
      const error = yield* resolveBunExecutable("Local device support", { PATH: "" }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("BunRuntimeUnavailableError");
      expect(error.message).toContain("Local device support requires Bun");
      expect(error.message).toContain("Install Bun");
    }).pipe(
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("finds a newly installed runtime immediately after a failed lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcessPlatform;
      const node = path.join(directory, platform === "win32" ? "bun.exe" : "bun");
      const env = { PATH: directory };
      expect(
        Result.isFailure(
          yield* resolveBunExecutable("Local device support", env).pipe(Effect.result),
        ),
      ).toBe(true);
      yield* fs.copyFile(bunExecutable, node);
      yield* fs.chmod(node, 0o755);
      expect(yield* resolveBunExecutable("Local device support", env)).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("rejects a hard-linked Bun alias pointing back at the standalone app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcessPlatform;
      const executable = path.join(directory, platform === "win32" ? "t3.exe" : "t3");
      const node = path.join(directory, platform === "win32" ? "bun.exe" : "bun");
      yield* fs.writeFileString(executable, "standalone executable fixture");
      yield* fs.chmod(executable, 0o755);
      yield* fs.link(executable, node);
      const error = yield* resolveBunExecutable("Local device support", { PATH: directory }).pipe(
        Effect.provideService(HostProcessExecutablePath, executable),
        Effect.flip,
      );
      expect(error._tag).toBe("BunRuntimeUnavailableError");
      expect(error.message).toContain("Install Bun");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("preserves the Bun alias used by runtime launchers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const platform = yield* HostProcessPlatform;
      const node = path.join(directory, platform === "win32" ? "bun.exe" : "bun");
      yield* fs.symlink(bunExecutable, node);
      expect(yield* resolveBunExecutable("Local device support", { PATH: directory })).toBe(node);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a Bun alias pointing back at the standalone app",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const platform = yield* HostProcessPlatform;
        const node = path.join(directory, platform === "win32" ? "bun.exe" : "bun");
        yield* fs.symlink(bunExecutable, node);
        const error = yield* resolveBunExecutable("Local device support", {
          PATH: directory,
        }).pipe(Effect.flip);
        expect(error.message).toContain("Install Bun");
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessExecutablePath, bunExecutable),
        Effect.provide(NodeServices.layer),
      ),
  );
});

it.effect("runs arbitrary helpers using the archive interpreter with no runtime on PATH", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const runtimeDirectory = path.join(directory, "runtime");
    yield* fs.makeDirectory(runtimeDirectory);
    yield* fs.symlink(bunExecutable, path.join(runtimeDirectory, "bun"));
    const helper = path.join(directory, "helper.mjs");
    yield* fs.writeFileString(
      helper,
      "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.HELPER_VALUE}))",
    );
    const runtime = yield* resolveBunExecutable("Device automation", { PATH: "" }).pipe(
      Effect.provideService(HostProcessExecutablePath, path.join(directory, "t3")),
      Effect.provideService(HostProcessIsExecutable, true),
    );
    const output = yield* spawner.string(
      ChildProcess.make(runtime, [helper, "a path with spaces"], {
        cwd: directory,
        env: { PATH: "", HELPER_VALUE: "from owning environment" },
        extendEnv: false,
      }),
    );
    expect(JSON.parse(output)).toEqual({
      args: ["a path with spaces"],
      cwd: yield* fs.realPath(directory),
      value: "from owning environment",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a Node interpreter configured for first-party helpers", () =>
  Effect.gen(function* () {
    const error = yield* resolveBunExecutable("Device automation", {
      PATH: "",
      T3_BUN_EXECUTABLE: process.execPath,
    }).pipe(
      Effect.provideService(HostProcessExecutablePath, "/packaged/t3"),
      Effect.provideService(HostProcessIsExecutable, true),
      Effect.flip,
    );
    expect(error._tag).toBe("BunRuntimeUnavailableError");
  }).pipe(Effect.provide(NodeServices.layer)),
);
