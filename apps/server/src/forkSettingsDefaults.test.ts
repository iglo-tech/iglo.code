import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  FORK_SERVER_DEFAULTS_STEPS,
  type ForkServerDefaultsStep,
  type ManagedPolicyDocument,
  withForkServerDefaults,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import {
  FORK_SERVER_DEFAULTS_VERSION,
  forkDefaultsVersionPath,
  withForkSettingsDefaults,
} from "./forkSettingsDefaults.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const makeServerSettingsLayer = (
  baseDir: string,
  options?: {
    readonly policy?: ManagedPolicyDocument;
    readonly steps?: ReadonlyArray<ForkServerDefaultsStep>;
  },
) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
  return withForkSettingsDefaults(ServerSettingsModule.layer, options?.steps).pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest(options?.policy)),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );
};

it.effect("applies v1 fork defaults on a fresh server and persists the version marker", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "iglo-fork-defaults-fresh-" });

    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      yield* service.start;
      const settings = yield* service.getSettings;

      assert.strictEqual(settings.defaultThreadEnvMode, "worktree");
      assert.strictEqual(settings.reviewGuidesEnabled, true);
      assert.strictEqual(settings.defaultAutoPull, true);
      assert.strictEqual(settings.storageCleanup.worktreeOnDelete, true);
      assert.strictEqual(settings.storageCleanup.worktreeOnMerge, true);
      assert.strictEqual(settings.storageCleanup.worktreeAfterDays, 2);
      assert.strictEqual(settings.storageCleanup.worktreeSettledAfterDays, 1);
      assert.strictEqual(settings.storageCleanup.worktreeKeepWhen, "save-changes");
      assert.strictEqual(settings.storageCleanup.worktreeUnchanged, true);
      assert.strictEqual(settings.branchNamingMode, "custom");
      assert.strictEqual(
        settings.branchNameInstructions,
        'Use "iglo-code/" followed by the issue ID and a short description.',
      );
      assert.strictEqual(settings.linkedEnvironmentsEnabled, true);
      assert.strictEqual(settings.workflowsEnabled, true);
      assert.strictEqual(settings.promptSuggestionsEnabled, true);
      assert.strictEqual(settings.autoResumeLimitedThreads, true);

      const versionRaw = yield* fs.readFileString(
        forkDefaultsVersionPath(config.settingsPath, path),
      );
      assert.strictEqual(versionRaw.trim(), String(FORK_SERVER_DEFAULTS_VERSION));
    }).pipe(Effect.provide(makeServerSettingsLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("applies fork defaults once on an existing server and preserves later manual edits", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "iglo-fork-defaults-existing-" });
    const { settingsPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });

    yield* fs.writeFileString(
      settingsPath,
      JSON.stringify({
        worktreesDirectory: "/custom/worktrees",
        defaultThreadEnvMode: "local",
        storageCleanup: { logsAfterDays: 14 },
      }),
    );

    // First boot applies v1 defaults while keeping unrelated settings, then user toggles two off.
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      const initial = yield* service.getSettings;
      assert.strictEqual(initial.worktreesDirectory, "/custom/worktrees");
      assert.strictEqual(initial.storageCleanup.logsAfterDays, 14);
      assert.strictEqual(initial.defaultThreadEnvMode, "worktree");
      assert.strictEqual(initial.workflowsEnabled, true);
      assert.strictEqual(initial.defaultAutoPull, true);

      yield* service.updateSettings({
        workflowsEnabled: false,
        defaultAutoPull: false,
        branchNameInstructions: "Use custom/",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer(baseDir)));

    // Second boot sees the version marker and keeps the user's manual edits intact.
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      const reloaded = yield* service.getSettings;
      assert.strictEqual(reloaded.worktreesDirectory, "/custom/worktrees");
      assert.strictEqual(reloaded.workflowsEnabled, false);
      assert.strictEqual(reloaded.defaultAutoPull, false);
      assert.strictEqual(reloaded.branchNameInstructions, "Use custom/");
      assert.strictEqual(reloaded.linkedEnvironmentsEnabled, true);
    }).pipe(Effect.provide(makeServerSettingsLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ignores corrupt settings.json and skips managed policy locked paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "iglo-fork-defaults-guards-" });
    const { settingsPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    const versionPath = forkDefaultsVersionPath(settingsPath, path);
    yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });

    // Corrupt settings file must stay untouched and must not mark fork defaults as applied.
    yield* fs.writeFileString(settingsPath, "{ invalid json");
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      assert.strictEqual(yield* fs.readFileString(settingsPath), "{ invalid json");
      assert.strictEqual(yield* fs.exists(versionPath), false);
    }).pipe(Effect.provide(makeServerSettingsLayer(baseDir)));

    // Once repaired, startup applies unlocked defaults and respects locked managed policy paths.
    yield* fs.writeFileString(settingsPath, "{}\n");
    const policy: ManagedPolicyDocument = {
      schemaVersion: 1,
      organization: "Test Org",
      settings: {
        workflowsEnabled: { value: false, locked: true },
        defaultThreadEnvMode: { value: "local", locked: true },
      },
    };
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      const settings = yield* service.getSettings;
      assert.strictEqual(settings.workflowsEnabled, false);
      assert.strictEqual(settings.defaultThreadEnvMode, "local");
      assert.strictEqual(settings.storageCleanup.worktreeAfterDays, 2);
      assert.strictEqual(settings.defaultAutoPull, true);
      assert.strictEqual(settings.storageCleanup.worktreeOnMerge, true);
    }).pipe(Effect.provide(makeServerSettingsLayer(baseDir, { policy })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("applies only steps newer than the recorded version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "iglo-fork-defaults-steps-" });
    const { settingsPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    const versionPath = forkDefaultsVersionPath(settingsPath, path);
    yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
    yield* fs.writeFileString(settingsPath, JSON.stringify({ workflowsEnabled: false }));
    yield* fs.writeFileString(versionPath, "1\n");

    const steps = [
      { version: 1, patch: { workflowsEnabled: true } },
      { version: 2, patch: { promptSuggestionsEnabled: true } },
    ];
    yield* Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      const settings = yield* service.getSettings;
      assert.strictEqual(settings.workflowsEnabled, false);
      assert.strictEqual(settings.promptSuggestionsEnabled, true);
      assert.strictEqual((yield* fs.readFileString(versionPath)).trim(), "2");
    }).pipe(Effect.provide(makeServerSettingsLayer(baseDir, { steps })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("Settings resets to what the server applies", () => {
  const applied = FORK_SERVER_DEFAULTS_STEPS.reduce(
    (settings, step) => applyServerSettingsPatch(settings, step.patch),
    DEFAULT_SERVER_SETTINGS,
  );
  const shown = withForkServerDefaults(DEFAULT_SERVER_SETTINGS);
  for (const key of new Set(
    FORK_SERVER_DEFAULTS_STEPS.flatMap((step) => Object.keys(step.patch)),
  )) {
    assert.deepStrictEqual(
      shown[key as keyof typeof shown],
      applied[key as keyof typeof applied],
      key,
    );
  }
});
