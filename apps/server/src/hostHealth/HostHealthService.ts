import type {
  HostHealthHistory,
  HostHealthHistoryInput,
  HostHealthSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";
import * as ResourceMonitorBinary from "../resourceTelemetry/ResourceMonitorBinary.ts";
import * as HostHealthCollector from "./HostHealthCollector.ts";
import * as HostHealthStore from "./HostHealthStore.ts";

const DEFAULT_SAMPLE_INTERVAL = Duration.seconds(10);
const DEFAULT_PRUNE_INTERVAL = Duration.minutes(10);

export interface HostHealthServiceOptions {
  readonly sampleInterval?: Duration.Duration;
  readonly pruneInterval?: Duration.Duration;
}

/**
 * This machine's health, sampled on a fixed cadence whether or not anyone watches, so the
 * history covers the time nobody had the page open.
 */
export class HostHealthService extends Context.Service<
  HostHealthService,
  {
    readonly latest: Effect.Effect<HostHealthSnapshot>;
    /** The latest sample, then every new one. */
    readonly subscribe: Effect.Effect<
      {
        readonly latest: HostHealthSnapshot;
        readonly changes: Stream.Stream<HostHealthSnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly readHistory: (input: HostHealthHistoryInput) => Effect.Effect<HostHealthHistory>;
  }
>()("t3/hostHealth/HostHealthService") {}

const make = Effect.fn("HostHealthService.make")(function* (
  options: HostHealthServiceOptions = {},
) {
  const collector = yield* HostHealthCollector.HostHealthCollector;
  const store = yield* HostHealthStore.HostHealthStore;
  const latestRef = yield* Ref.make<Option.Option<HostHealthSnapshot>>(Option.none());
  const changes = yield* PubSub.sliding<HostHealthSnapshot>(8);

  const sample = Effect.gen(function* () {
    const snapshot = yield* collector.collect;
    yield* Ref.set(latestRef, Option.some(snapshot));
    yield* store
      .record(snapshot)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not save a host health sample.").pipe(
            Effect.annotateLogs({ operation: error.operation, cause: String(error.cause) }),
          ),
        ),
      );
    yield* PubSub.publish(changes, snapshot);
    return snapshot;
  });

  yield* sample.pipe(
    Effect.repeat(Schedule.spaced(options.sampleInterval ?? DEFAULT_SAMPLE_INTERVAL)),
    Effect.forkScoped,
  );

  yield* Clock.currentTimeMillis.pipe(
    Effect.flatMap(store.prune),
    Effect.catch((error) =>
      Effect.logWarning("Could not prune host health history.").pipe(
        Effect.annotateLogs({ operation: error.operation, cause: String(error.cause) }),
      ),
    ),
    Effect.repeat(Schedule.spaced(options.pruneInterval ?? DEFAULT_PRUNE_INTERVAL)),
    Effect.forkScoped,
  );

  const latest = Ref.get(latestRef).pipe(
    Effect.flatMap(Option.match({ onNone: () => sample, onSome: Effect.succeed })),
  );

  // A sample that lands twice is harmless here, so no ordering lock is needed.
  const subscribe = subscribeBeforeSnapshotWithoutMutex(changes, latest);

  const readHistory = Effect.fn("HostHealthService.readHistory")(function* (
    input: HostHealthHistoryInput,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* store.readHistory(input.range, nowMs).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read host health history.").pipe(
          Effect.annotateLogs({ operation: error.operation, cause: String(error.cause) }),
          Effect.as({
            range: input.range,
            resolutionSeconds: HostHealthStore.RANGE_QUERY_CONFIG[input.range].resolutionSeconds,
            points: [],
          }),
        ),
      ),
    );
  });

  return HostHealthService.of({ latest, subscribe, readHistory });
});

export const layer = Layer.effect(HostHealthService, make());

export const layerLive = layer.pipe(
  Layer.provide(HostHealthCollector.layer.pipe(Layer.provide(ResourceMonitorBinary.layer))),
  Layer.provide(HostHealthStore.layerConfig),
);
