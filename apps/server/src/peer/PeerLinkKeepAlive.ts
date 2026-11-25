import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../serverActivation.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * A link's session ends after 30 idle days and renews in one-day steps, so a
 * daily ping keeps every link between running machines alive. Each side pings
 * the links it holds, which covers both directions of a reciprocal link.
 */
export const keepAliveOnce = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;
  if (!(yield* links.enabled)) return;
  const names = yield* links.names.pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    names,
    ({ environmentId }) =>
      client.keepAlive(environmentId).pipe(
        // Recorded on the link, where Settings shows it.
        Effect.catch((error) =>
          Effect.logDebug("Peer link keepalive failed.", { environmentId, error: error.message }),
        ),
      ),
    { discard: true },
  );
});

export const layer = Layer.effectDiscard(
  forkParked(keepAliveOnce.pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.asVoid)),
);
