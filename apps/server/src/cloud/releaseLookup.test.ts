import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ReleaseLookup from "./releaseLookup.ts";

const manifests: Record<string, unknown> = {
  "https://github.com/iglo-tech/iglo.code/releases/download/v1.2.3/release.json": {
    version: "1.2.3",
    databaseMigration: 82,
  },
  // A manifest for another version proves nothing about this one.
  "https://github.com/iglo-tech/iglo.code/releases/download/v1.2.4-nightly.20261031.2/release.json":
    { version: "1.2.4-nightly.20261030.1", databaseMigration: 84 },
};

it.effect("answers each desktop track from GitHub Releases and shares one lookup", () =>
  Effect.gen(function* () {
    let indexRequests = 0;
    const service = yield* ReleaseLookup.make().pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (request.url.startsWith("https://api.github.com/")) {
            indexRequests += 1;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json([
                  { tag_name: "v1.3.0-nightly.20261101.4", draft: true },
                  { tag_name: "v1.2.4-nightly.20261031.2" },
                  { tag_name: "v1.2.3" },
                ]),
              ),
            );
          }
          const manifest = manifests[request.url];
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              manifest === undefined
                ? new Response("not found", { status: 404 })
                : Response.json(manifest),
            ),
          );
        }),
      ),
      Effect.provide(ManagedPolicy.layerTest()),
    );

    assert.deepStrictEqual(yield* service.get({ channel: "latest" }), {
      version: "1.2.3",
      databaseMigration: 82,
    });
    assert.deepStrictEqual(yield* service.get({ channel: "nightly" }), {
      version: "1.2.4-nightly.20261031.2",
    });
    yield* service.get({ channel: "latest" });
    assert.equal(indexRequests, 2);
  }).pipe(Effect.provideService(HostProcess.Environment, {})),
);

it.effect("reads a managed mirror's manifest beside its archives", () =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const service = yield* ReleaseLookup.make().pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requested.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.includes("latest-linux.yml")
                ? new Response("version: 1.2.3\n")
                : Response.json({ version: "1.2.3", databaseMigration: 82 }),
            ),
          );
        }),
      ),
      Effect.provide(
        ManagedPolicy.layerTest({
          schemaVersion: 1,
          organization: "Acme",
          limits: { updates: { mode: "auto", feedUrl: "https://mirror.example/iglo?token=t" } },
        }),
      ),
    );

    assert.deepStrictEqual(yield* service.get({ channel: "latest" }), {
      version: "1.2.3",
      databaseMigration: 82,
    });
    assert.deepStrictEqual(requested, [
      "https://mirror.example/iglo/latest-linux.yml?token=t",
      "https://mirror.example/iglo/v1.2.3/release.json?token=t",
    ]);
  }).pipe(
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
  ),
);
