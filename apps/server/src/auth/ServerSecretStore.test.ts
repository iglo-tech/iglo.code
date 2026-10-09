import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ProviderCredentialStore from "../provider/ProviderCredentialStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerRemoveFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRemoveFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRemoveFailureFileSystem),
  );

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          let firstRead = true;
          return {
            ...fs,
            readFile: (path) =>
              Effect.suspend(() => {
                if (!firstRead) return fs.readFile(path);
                firstRead = false;
                // Another process publishes its secret between our read and create.
                return fs.writeFile(path, Uint8Array.from([1, 2, 3])).pipe(
                  Effect.andThen(
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                      }),
                    ),
                  ),
                );
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
  );

const layerRecordingSecretStore = (reads: string[]) =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(layerServerConfig()),
    Layer.provideMerge(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.map(
          FileSystem.FileSystem,
          (fs) =>
            ({
              ...fs,
              readFile: (path) =>
                Effect.sync(() => reads.push(String(path))).pipe(Effect.andThen(fs.readFile(path))),
            }) satisfies FileSystem.FileSystem,
        ),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns and caches the persisted secret when another creator wins", () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      assert.deepEqual(
        yield* store.getOrCreateRandom("session-signing-key", 32),
        Uint8Array.from([1, 2, 3]),
      );
      assert.deepEqual(
        yield* store.getOrCreateRandom("session-signing-key", 32),
        Uint8Array.from([1, 2, 3]),
      );
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("reads an existing secret once even for concurrent first reads", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.writeFile(`${config.secretsDir}/existing.bin`, Uint8Array.from([1, 2, 3]));
      const [first, second] = yield* Effect.all(
        [store.getOrCreateRandom("existing", 32), store.getOrCreateRandom("existing", 32)],
        {
          concurrency: "unbounded",
        },
      );
      first[0] = 99;
      assert.deepEqual(second, Uint8Array.from([1, 2, 3]));
      assert.deepEqual(yield* store.getOrCreateRandom("existing", 32), Uint8Array.from([1, 2, 3]));
      assert.lengthOf(reads, 1);
    }).pipe(Effect.provide(layerRecordingSecretStore(reads)));
  });

  it.effect("keeps cached secrets consistent with set, remove, and recreation", () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const [generated, concurrent] = yield* Effect.all(
        [store.getOrCreateRandom("mutable", 32), store.getOrCreateRandom("mutable", 32)],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(generated, concurrent);
      generated[0] = generated[0]! ^ 255;
      assert.notDeepEqual(yield* store.getOrCreateRandom("mutable", 32), generated);
      assert.lengthOf(reads, 1);
      const replacement = Uint8Array.from([4, 5, 6]);
      yield* store.set("mutable", replacement);
      replacement[0] = 99;
      assert.deepEqual(yield* store.getOrCreateRandom("mutable", 32), Uint8Array.from([4, 5, 6]));
      assert.lengthOf(reads, 1);
      yield* store.remove("mutable");
      assert.isTrue(Option.isNone(yield* store.get("mutable")));
      yield* store.create("mutable", Uint8Array.from([7, 8, 9]));
      assert.deepEqual(yield* store.getOrCreateRandom("mutable", 32), Uint8Array.from([7, 8, 9]));
      assert.lengthOf(reads, 3);
    }).pipe(Effect.provide(layerRecordingSecretStore(reads)));
  });

  it.effect("plain reads observe another store's writes and removal even after caching", () =>
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      const other = yield* ServerSecretStore.make;
      yield* store.getOrCreateRandom("cli-secret", 32);
      yield* store.get("cli-secret");
      yield* other.set("cli-secret", Uint8Array.from([2]));
      assert.deepEqual(Option.getOrThrow(yield* store.get("cli-secret")), Uint8Array.from([2]));
      yield* other.remove("cli-secret");
      assert.isTrue(Option.isNone(yield* store.get("cli-secret")));
    }).pipe(Effect.provide(layerRecordingSecretStore([]))),
  );

  it.effect("credential reads see writes and removal by another store", () =>
    Effect.gen(function* () {
      const credentials = yield* ProviderCredentialStore.make("codex-chatgpt", "test");
      const other = yield* ServerSecretStore.make;
      yield* credentials.set(Uint8Array.from([1]));
      assert.deepEqual(Option.getOrThrow(yield* credentials.get), Uint8Array.from([1]));
      yield* other.set(credentials.binding.key, Uint8Array.from([2]));
      assert.deepEqual(Option.getOrThrow(yield* credentials.get), Uint8Array.from([2]));
      yield* other.remove(credentials.binding.key);
      assert.isTrue(Option.isNone(yield* credentials.get));
    }).pipe(Effect.provide(layerRecordingSecretStore([]))),
  );

  it.effect("invalidates the cache when a write fails after replacing the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let failChmod = false;
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          chmod: (path, mode) =>
            failChmod && String(path).endsWith("/partial.bin")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "chmod",
                    pathOrDescriptor: String(path),
                  }),
                )
              : fs.chmod(path, mode),
        }),
      );
      yield* store.getOrCreateRandom("partial", 32);
      failChmod = true;
      const error = yield* Effect.flip(store.set("partial", Uint8Array.from([9])));
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.deepEqual(yield* store.getOrCreateRandom("partial", 32), Uint8Array.from([9]));
    }).pipe(Effect.provide(layerRecordingSecretStore([]))),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const layerRecordingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            makeDirectory: () => Effect.void,
            writeFile: () => Effect.void,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const secretStore = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(layerServerConfig()),
            Layer.provideMerge(layerRecordingFileSystem),
          ),
        ),
      );

      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));

      assert.isTrue(
        chmodCalls.some((call) => call.mode === 0o700 && /[\\/]secrets$/.test(call.path)),
      );
      assert.isAtLeast(chmodCalls.filter((call) => call.mode === 0o600).length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRemoveFailureSecretStore())),
  );
});
