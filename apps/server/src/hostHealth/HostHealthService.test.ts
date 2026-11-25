import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeSnapshot } from "./HostHealth.testkit.ts";
import * as HostHealthCollector from "./HostHealthCollector.ts";
import * as HostHealthService from "./HostHealthService.ts";
import * as HostHealthStore from "./HostHealthStore.ts";

/** Each sample's CPU reading counts up from 1, so a test can tell samples apart. */
const layer = Layer.unwrap(
  Effect.gen(function* () {
    const count = yield* Ref.make(0);
    const collector = HostHealthCollector.HostHealthCollector.of({
      collect: Effect.gen(function* () {
        const cpu = yield* Ref.updateAndGet(count, (n) => n + 1);
        return makeSnapshot(yield* Clock.currentTimeMillis, { cpu });
      }),
    });
    return HostHealthService.layer.pipe(
      Layer.provide(Layer.succeed(HostHealthCollector.HostHealthCollector, collector)),
      Layer.provide(HostHealthStore.layerMemory),
    );
  }),
);

describe("HostHealthService", () => {
  it.effect("samples on its own cadence and keeps every sample in history", () =>
    Effect.gen(function* () {
      const service = yield* HostHealthService.HostHealthService;
      yield* TestClock.adjust("30 seconds");

      const history = yield* service.readHistory({ range: "1h" });
      assert.deepStrictEqual(
        history.points.map((point) => point.cpuPercent),
        [1, 2, 3, 4],
      );
      assert.strictEqual((yield* service.latest).cpu.utilizationPercent, 4);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a subscriber gets the latest sample, then each new one", () =>
    Effect.gen(function* () {
      const service = yield* HostHealthService.HostHealthService;
      yield* TestClock.adjust("0 seconds");
      const { latest, changes } = yield* service.subscribe;
      const next = yield* changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* TestClock.adjust("20 seconds");

      assert.strictEqual(latest.cpu.utilizationPercent, 1);
      assert.deepStrictEqual(
        (yield* Fiber.join(next)).map((snapshot) => snapshot.cpu.utilizationPercent),
        [2, 3],
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
