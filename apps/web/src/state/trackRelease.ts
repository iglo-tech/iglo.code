import {
  type DesktopUpdateChannel,
  type ServerConfig,
  ServerReleaseError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

const isServerReleaseError = Schema.is(ServerReleaseError);

function unsupportedLookup(config: ServerConfig | null): ServerReleaseError | null {
  if (config === null) {
    return new ServerReleaseError({ reason: "Connect to this server to check releases." });
  }
  return config.environment.capabilities.releaseLookup === true
    ? null
    : new ServerReleaseError({
        reason: "This server cannot look up releases. Update it before switching tracks.",
      });
}

export function trackReleaseFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return isServerReleaseError(error)
    ? error.message
    : "Could not check iglo.code releases. Check the connection and try again.";
}

/** The newest release on `channel`, looked up by a connected server so its update source decides. */
export const trackReleaseAtom = Atom.family((channel: DesktopUpdateChannel) =>
  Atom.make((get) => {
    const primary = get(primaryEnvironmentIdAtom);
    // Without a primary environment, any connected server can answer.
    const candidates =
      primary === null ? get(environmentSummaries.connectedEnvironmentIdsAtom) : [primary];
    const environmentId =
      candidates.find(
        (id) => unsupportedLookup(get(serverEnvironment.configValueAtom(id))) === null,
      ) ?? candidates[0];
    if (environmentId === undefined) {
      return Effect.fail(
        new ServerReleaseError({ reason: "Connect to a server to check releases." }),
      );
    }
    const unsupported = unsupportedLookup(get(serverEnvironment.configValueAtom(environmentId)));
    if (unsupported !== null) return Effect.fail(unsupported);
    return get.result(serverEnvironment.release({ environmentId, input: { channel } })).pipe(
      Effect.map((release) => ({
        version: release.version,
        databaseMigration: release.databaseMigration,
      })),
    );
  }).pipe(Atom.withLabel(`track-release:${channel}`)),
);
