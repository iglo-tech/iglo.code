import {
  FORK_SERVER_DEFAULTS_STEPS,
  type ForkServerDefaultsStep,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "./config.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

export const FORK_SERVER_DEFAULTS_VERSION =
  FORK_SERVER_DEFAULTS_STEPS[FORK_SERVER_DEFAULTS_STEPS.length - 1]?.version ?? 0;

export function forkDefaultsVersionPath(settingsPath: string, pathService: Path.Path): string {
  return pathService.join(pathService.dirname(settingsPath), "fork-defaults-version");
}

function isPathLocked(path: string, locked: ReadonlySet<string>): boolean {
  if (locked.has(path)) return true;
  const segments = path.split(".");
  for (let index = 1; index < segments.length; index++) {
    if (locked.has(segments.slice(0, index).join("."))) return true;
  }
  if (path.startsWith("storageCleanup.worktree") && locked.has("worktreeCleanup")) {
    return true;
  }
  return false;
}

function filterUnlockedPatch(
  patch: ServerSettingsPatch,
  lockedPaths: ReadonlyArray<string>,
): ServerSettingsPatch {
  if (lockedPaths.length === 0) return patch;
  const locked = new Set(lockedPaths);
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPathLocked(key, locked)) continue;
    if (key === "storageCleanup" && value !== null && typeof value === "object") {
      const storagePatch: Record<string, unknown> = {};
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (!isPathLocked(`storageCleanup.${subKey}`, locked)) {
          storagePatch[subKey] = subValue;
        }
      }
      if (Object.keys(storagePatch).length > 0) {
        filtered[key] = storagePatch;
      }
      continue;
    }
    filtered[key] = value;
  }
  return filtered as ServerSettingsPatch;
}

const readForkDefaultsVersion = Effect.fn("forkSettingsDefaults.readVersion")(function* (
  versionPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(versionPath).pipe(Effect.orElseSucceed(() => ""));
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
});

const writeForkDefaultsVersion = Effect.fn("forkSettingsDefaults.writeVersion")(function* (
  versionPath: string,
  version: number,
) {
  return yield* writeFileStringAtomically({
    filePath: versionPath,
    contents: `${version}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: versionPath,
          operation: "write-file",
          cause,
        }),
    ),
  );
});

/**
 * Wraps `ServerSettingsService` so startup applies pending fork default steps once through
 * `updateSettings`, keeping `serverSettings.ts` untouched and inheriting its vetting and
 * corrupt-file guards.
 */
export const withForkSettingsDefaults = <E, R>(
  base: Layer.Layer<ServerSettingsModule.ServerSettingsService, E, R>,
  steps: ReadonlyArray<ForkServerDefaultsStep> = FORK_SERVER_DEFAULTS_STEPS,
) =>
  Layer.effect(
    ServerSettingsModule.ServerSettingsService,
    Effect.gen(function* () {
      const inner = yield* ServerSettingsModule.ServerSettingsService;
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const versionPath = forkDefaultsVersionPath(settingsPath, pathService);
      const applySemaphore = yield* Semaphore.make(1);

      const applyPendingSteps = applySemaphore.withPermits(1)(
        Effect.gen(function* () {
          const appliedVersion = yield* readForkDefaultsVersion(versionPath).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          );
          const pending = steps.filter((step) => step.version > appliedVersion);
          if (pending.length === 0) return;

          const lockedPaths = inner.managedPolicy?.lockedSettings ?? [];
          for (const step of pending) {
            const patch = filterUnlockedPatch(step.patch, lockedPaths);
            if (Object.keys(patch).length > 0) {
              const result = yield* Effect.result(inner.updateSettings(patch));
              if (Result.isFailure(result)) {
                yield* Effect.logWarning("Skipped applying fork server settings defaults", {
                  settingsPath,
                  version: step.version,
                  operation: result.failure.operation,
                  cause: result.failure.cause,
                });
                return;
              }
            }
            yield* writeForkDefaultsVersion(versionPath, step.version).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, pathService),
            );
          }
        }),
      );

      return {
        managedPolicy: inner.managedPolicy,
        start: inner.start.pipe(Effect.andThen(applyPendingSteps)),
        ready: inner.ready,
        getSettings: inner.getSettings,
        updateSettings: inner.updateSettings,
        updateProviderInstance: inner.updateProviderInstance,
        withSettingsSnapshot: inner.withSettingsSnapshot,
        get streamChanges() {
          return inner.streamChanges;
        },
        get subscribeChanges() {
          return inner.subscribeChanges;
        },
      } satisfies ServerSettingsModule.ServerSettingsService["Service"];
    }),
  ).pipe(Layer.provide(base));
