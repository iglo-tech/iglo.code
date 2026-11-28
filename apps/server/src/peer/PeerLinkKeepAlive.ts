import * as Duration from "effect/Duration";
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

/** How often every link is checked while all of them work. */
export const CHECK_INTERVAL = Duration.minutes(10);
/** The first check waits for startup to settle; a link in trouble is checked again from here. */
const FIRST_CHECK_DELAY = Duration.seconds(30);
const CHECK_CONCURRENCY = 4;

/**
 * When to check again after `failures` rounds in a row had a link in trouble:
 * soon at first, then backing off to the regular interval.
 */
export const nextCheckDelay = (failures: number): Duration.Duration =>
  failures === 0
    ? CHECK_INTERVAL
    : Duration.min(Duration.times(FIRST_CHECK_DELAY, 2 ** (failures - 1)), CHECK_INTERVAL);

/**
 * Checks every unexpired link once, so a recorded error clears once its peer
 * works again and a revoked link shows as soon as it is. Whether all of them work.
 */
export const checkLinksOnce = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  if (!(yield* links.enabled)) return true;
  const names = yield* links.names.pipe(Effect.orElseSucceed(() => []));
  const healthy = yield* Effect.forEach(
    names,
    ({ environmentId }) =>
      links.check(environmentId).pipe(
        Effect.map((link) => link.status === "reachable" && link.lastError === null),
        Effect.catch((error) =>
          Effect.logDebug("Peer link check failed.", { environmentId, error: error.message }).pipe(
            Effect.as(false),
          ),
        ),
      ),
    { concurrency: CHECK_CONCURRENCY },
  );
  return healthy.every(Boolean);
});

const checkLinksForever = Effect.gen(function* () {
  yield* Effect.sleep(FIRST_CHECK_DELAY);
  let failures = 0;
  while (true) {
    // A defect in one round must not end the loop, or a stale error would stay until restart.
    const healthy = yield* checkLinksOnce.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Checking peer links failed.", { cause }).pipe(Effect.as(false)),
      ),
    );
    failures = healthy ? 0 : failures + 1;
    yield* Effect.sleep(nextCheckDelay(failures));
  }
});

export const layer = Layer.effectDiscard(
  Effect.all(
    [
      forkParked(keepAliveOnce.pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.asVoid)),
      forkParked(checkLinksForever),
    ],
    { discard: true },
  ),
);
