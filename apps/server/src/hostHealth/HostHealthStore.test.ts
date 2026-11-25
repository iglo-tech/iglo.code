import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeSnapshot } from "./HostHealth.testkit.ts";
import * as HostHealthStore from "./HostHealthStore.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A bucket boundary, so rollup grouping is easy to predict.
const START = Date.UTC(2026, 10, 24, 12, 0, 0);

describe("HostHealthStore", () => {
  it.effect("serves the last hour as the raw samples, oldest first", () =>
    Effect.gen(function* () {
      const store = yield* HostHealthStore.HostHealthStore;
      yield* store.record(makeSnapshot(START + 10_000, { cpu: 30 }));
      yield* store.record(makeSnapshot(START, { cpu: null }));
      yield* store.record(makeSnapshot(START - 2 * HOUR, { cpu: 99 }));

      const history = yield* store.readHistory("1h", START + MINUTE);
      assert.strictEqual(history.resolutionSeconds, 10);
      assert.deepStrictEqual(
        history.points.map((point) => [point.timestamp, point.cpuPercent]),
        [
          [START, null],
          [START + 10_000, 30],
        ],
      );
    }).pipe(Effect.provide(HostHealthStore.layerMemory)),
  );

  it.effect("averages longer ranges from the rollups, skipping samples that had no value", () =>
    Effect.gen(function* () {
      const store = yield* HostHealthStore.HostHealthStore;
      // Two minutes of samples fall into one 24h point (2-minute resolution).
      yield* store.record(makeSnapshot(START, { cpu: 20, memoryUsed: 400, rx: null, temp: 50 }));
      yield* store.record(makeSnapshot(START + 30_000, { cpu: null, memoryUsed: 600, temp: 70 }));
      yield* store.record(makeSnapshot(START + 90_000, { cpu: 40, memoryUsed: 500, rx: 300 }));
      yield* store.record(makeSnapshot(START + 3 * MINUTE, { cpu: 90 }));

      const history = yield* store.readHistory("24h", START + 5 * MINUTE);
      assert.strictEqual(history.resolutionSeconds, 120);
      const [first, second] = history.points;
      assert.deepStrictEqual(
        {
          timestamp: first?.timestamp,
          cpu: first?.cpuPercent,
          memory: first?.memoryUsedBytes,
          rx: first?.netRxBytesPerSec,
          temp: first?.maxTempCelsius,
        },
        { timestamp: START, cpu: 30, memory: 500, rx: 200, temp: 70 },
      );
      assert.deepStrictEqual([second?.timestamp, second?.cpuPercent], [START + 2 * MINUTE, 90]);

      const month = yield* store.readHistory("30d", START + 5 * MINUTE);
      assert.strictEqual(month.points.length, 1);
      assert.strictEqual(month.points[0]?.cpuPercent, 50);
    }).pipe(Effect.provide(HostHealthStore.layerMemory)),
  );

  it.effect("prunes raw samples after two hours while rollups keep the longer history", () =>
    Effect.gen(function* () {
      const store = yield* HostHealthStore.HostHealthStore;
      yield* store.record(makeSnapshot(START, { cpu: 25 }));
      const later = START + 3 * HOUR;
      yield* store.prune(later);

      assert.deepStrictEqual((yield* store.readHistory("1h", later)).points, []);
      const day = yield* store.readHistory("24h", later);
      assert.deepStrictEqual(
        day.points.map((point) => point.cpuPercent),
        [25],
      );

      yield* store.prune(START + 8 * 24 * HOUR);
      assert.deepStrictEqual((yield* store.readHistory("7d", START + 8 * 24 * HOUR)).points, []);
      assert.strictEqual((yield* store.readHistory("30d", START + 8 * 24 * HOUR)).points.length, 1);
    }).pipe(Effect.provide(HostHealthStore.layerMemory)),
  );
});
