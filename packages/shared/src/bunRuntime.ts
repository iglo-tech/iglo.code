import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const BUN_VERSION = "1.4.0";

export const isSupportedBunVersion = (version: string | undefined): boolean => {
  if (version === undefined || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) return false;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 4);
};

import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
} from "./hostProcess.ts";
import { CommandResolutionCache, resolveCommandPath } from "./shell.ts";

const BunRuntimeFeature = Schema.Literals([
  "Local device support",
  "Device automation",
  "Antigravity",
  "Antigravity sign-in",
]);

export const bunRuntimeUnavailableMessage = (feature: typeof BunRuntimeFeature.Type): string =>
  `${feature} requires Bun ${BUN_VERSION} or newer. Install Bun and make sure bun is on PATH, then retry.`;

export class BunRuntimeUnavailableError extends Schema.TaggedError<BunRuntimeUnavailableError>()(
  "BunRuntimeUnavailableError",
  { feature: BunRuntimeFeature, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return bunRuntimeUnavailableMessage(this.feature);
  }
}

export interface SelfInvocation {
  /** The binary to spawn: Bun or the compiled T3 executable. */
  readonly command: string;
  /**
   * The absolute entrypoint script to place before the subcommand, or
   * undefined for the compiled binary, which dispatches its embedded CLI.
   */
  readonly entrypoint: string | undefined;
}

/**
 * How another process runs this T3 install's CLI, for hidden subcommands the
 * server hands to children such as `acp-mcp-bridge`. `process.execPath` plus
 * `argv[1]` only works for a source script; compiled Bun points to an embedded
 * entrypoint in its virtual filesystem, so callers must not
 * assemble the pair themselves.
 */
export const resolveSelfInvocation = Effect.fn("bunRuntime.resolveSelfInvocation")(function* () {
  const command = yield* HostProcessExecutablePath;
  if (yield* HostProcessIsExecutable)
    return { command, entrypoint: undefined } satisfies SelfInvocation;
  const path = yield* Path.Path;
  const entry = (yield* HostProcessArguments)[1];
  // Children spawn from their own working directory, so the script path must be absolute.
  return {
    command,
    entrypoint: entry === undefined ? undefined : path.resolve(entry),
  } satisfies SelfInvocation;
});

/** `[entrypoint?, ...args]`: the argv that runs `args` against this T3 install. */
export const selfInvocationArgs = (
  invocation: SelfInvocation,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  invocation.entrypoint === undefined ? args : [invocation.entrypoint, ...args];

/** A standalone T3 binary runs its embedded CLI, regardless of script arguments. */
export const resolveBunExecutable = Effect.fn("bunRuntime.resolveBunExecutable")(function* (
  feature: typeof BunRuntimeFeature.Type,
  environment?: NodeJS.ProcessEnv,
) {
  const executablePath = yield* HostProcessExecutablePath;
  if (!(yield* HostProcessIsExecutable)) return executablePath;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = environment ?? (yield* HostProcessEnvironment);
  const bundledRuntime = path.join(path.dirname(executablePath), "runtime", "bun");
  const bunPath = env.T3_BUN_EXECUTABLE
    ? path.resolve(env.T3_BUN_EXECUTABLE)
    : (yield* fs.exists(bundledRuntime))
      ? bundledRuntime
      : yield* resolveCommandPath("bun", { env }).pipe(
          Effect.provideService(CommandResolutionCache, new Map()),
          Effect.map((commandPath) => path.resolve(commandPath)),
          Effect.mapError((cause) => new BunRuntimeUnavailableError({ feature, cause })),
        );
  // A launcher or symlink named bun must not point back at the standalone app.
  const resolvedPath = yield* fs
    .realPath(bunPath)
    .pipe(Effect.mapError((cause) => new BunRuntimeUnavailableError({ feature, cause })));
  if (resolvedPath === executablePath) return yield* new BunRuntimeUnavailableError({ feature });
  const [hostInfo, bunInfo] = yield* Effect.all([
    fs.stat(executablePath).pipe(Effect.option),
    fs.stat(bunPath).pipe(Effect.option),
  ]);
  if (
    Option.isSome(hostInfo) &&
    Option.isSome(bunInfo) &&
    hostInfo.value.dev === bunInfo.value.dev &&
    Option.isSome(hostInfo.value.ino) &&
    Option.isSome(bunInfo.value.ino) &&
    Number.isSafeInteger(hostInfo.value.ino.value) &&
    hostInfo.value.ino.value > 0 &&
    hostInfo.value.ino.value === bunInfo.value.ino.value
  ) {
    return yield* new BunRuntimeUnavailableError({ feature });
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const version = yield* spawner
    .string(
      ChildProcess.make(bunPath, ["-p", "process.versions.bun ?? ''"], {
        env,
        extendEnv: false,
      }),
    )
    .pipe(Effect.mapError((cause) => new BunRuntimeUnavailableError({ feature, cause })));
  if (!isSupportedBunVersion(version.trim()))
    return yield* new BunRuntimeUnavailableError({ feature });
  return bunPath;
});
