import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessExecutablePath, HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveStaticDir } from "./config.ts";

it.layer(NodeServices.layer)("static client resolution", (it) => {
  it.effect("serves the on-disk client beside a Bun archive executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const archiveDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-static-archive-" });
      const clientDir = path.join(archiveDir, "client");
      yield* fs.makeDirectory(clientDir);
      yield* fs.writeFileString(path.join(clientDir, "index.html"), "<html>packaged client</html>");
      const resolved = yield* resolveStaticDir().pipe(
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessExecutablePath, path.join(archiveDir, "t3")),
      );
      assert.equal(resolved, clientDir);
    }),
  );

  it.effect.each([true, false])(
    "preserves source client resolution (sibling client available: %s)",
    (siblingAvailable) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sibling = path.join(import.meta.dirname, "client");
        const monorepo = path.resolve(import.meta.dirname, "../../web/dist");
        const resolved = yield* resolveStaticDir().pipe(
          Effect.provideService(HostProcessIsExecutable, false),
          Effect.provideService(HostProcessExecutablePath, "/unrelated/bun"),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              exists: (file) =>
                Effect.succeed(
                  file === path.join(monorepo, "index.html") ||
                    (siblingAvailable && file === path.join(sibling, "index.html")),
                ),
            }),
          ),
        );
        assert.equal(resolved, siblingAvailable ? sibling : monorepo);
      }),
  );

  it.effect("does not serve a source checkout when an archive is missing its client", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const monorepo = path.resolve(import.meta.dirname, "../../web/dist");
      const resolved = yield* resolveStaticDir().pipe(
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessExecutablePath, "/isolated/archive/t3"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) => Effect.succeed(file === path.join(monorepo, "index.html")),
          }),
        ),
      );
      assert.isUndefined(resolved);
    }),
  );
});
