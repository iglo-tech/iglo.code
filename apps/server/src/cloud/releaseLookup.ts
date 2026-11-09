import {
  ServerReleaseError,
  ServerReleaseInput,
  type DesktopUpdateChannel,
  type ServerRelease,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_MANIFEST_FILE,
  cliReleaseAssetUrl,
} from "@t3tools/shared/cliRelease";

import { resolveTrackVersion } from "../cli/update.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateMirror } from "../policy/managedUpdates.ts";

const decodeInput = Schema.decodeUnknownEffect(ServerReleaseInput);
/** The release.json a release publishes; `apps/server/scripts/cli.ts release-manifest` writes it. */
export const ReleaseManifest = Schema.Struct({
  version: Schema.String,
  databaseMigration: Schema.Int,
});
const decodeManifest = Schema.decodeUnknownEffect(ReleaseManifest);

export class ReleaseLookup extends Context.Service<
  ReleaseLookup,
  {
    readonly get: (input: ServerReleaseInput) => Effect.Effect<ServerRelease, ServerReleaseError>;
  }
>()("t3/cloud/releaseLookup") {}

export const make = Effect.fn("ReleaseLookup.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const mirror = managedUpdateMirror((yield* ManagedPolicy.ManagedPolicy).document);
  const environment = yield* HostProcess.Environment;
  const releaseBaseUrl =
    mirror?.feedUrl ?? (environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined);
  // Undefined when the release has no readable manifest, which keeps a track switch blocked.
  const databaseMigrationOf = (version: string) =>
    http.get(cliReleaseAssetUrl(version, CLI_RELEASE_MANIFEST_FILE, releaseBaseUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeManifest),
      Effect.timeout(Duration.seconds(30)),
      Effect.map((manifest) =>
        manifest.version === version ? manifest.databaseMigration : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );
  // GitHub's unauthenticated API allows 60 requests an hour, so every client shares one answer.
  const cache = yield* Cache.make({
    capacity: 2,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("ReleaseLookup.lookup")(function* (channel: DesktopUpdateChannel) {
      const version = yield* resolveTrackVersion(
        mirror,
        channel === "nightly" ? "nightly" : "stable",
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) => new ServerReleaseError({ reason: error.reason })),
      );
      const databaseMigration = yield* databaseMigrationOf(version);
      return (
        databaseMigration === undefined ? { version } : { version, databaseMigration }
      ) satisfies ServerRelease;
    }),
  });
  return ReleaseLookup.of({
    get: Effect.fn("ReleaseLookup.get")(function* (input) {
      const { channel } = yield* decodeInput(input).pipe(
        Effect.mapError(() => new ServerReleaseError({ reason: "Invalid update track." })),
      );
      return yield* Cache.get(cache, channel);
    }),
  });
});

export const layer = Layer.effect(ReleaseLookup, make()).pipe(
  Layer.provide([FetchHttpClient.layer, ManagedPolicy.layer]),
);
