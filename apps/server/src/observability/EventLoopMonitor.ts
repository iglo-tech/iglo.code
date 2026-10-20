// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks exposes the event loop delay histogram.
import * as NodePerfHooks from "node:perf_hooks";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as Metrics from "./Metrics.ts";

// Bun's native histogram records timer lateness, already excluding the resolution.
// It can undercount a stall by up to RESOLUTION_MS. Every stall over 3 s is caught
// with these values, at one native wakeup per second that never enters JS.
const RESOLUTION_MS = 1000;
const STALL_THRESHOLD_MS = 2000;
const SAMPLE_INTERVAL = "30 seconds";
const STALL_LOG_MAX_BYTES = 256 * 1024;

/** One sample interval: timer lateness in ns, host suspension in ms, CPU in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  readonly suspendedMs: number;
  readonly usage: Pick<
    NodeJS.ResourceUsage,
    | "userCPUTime"
    | "systemCPUTime"
    | "majorPageFault"
    | "minorPageFault"
    | "involuntaryContextSwitches"
  >;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  /** Wall time the readings cover. */
  readonly elapsedMs: number;
}

// Enables the delay histogram for the layer's lifetime. Each read returns the
// readings since the previous read and resets the histogram. Bun does not implement
// eventLoopUtilization, so its zero counters cannot distinguish stalls from sleep.
const makeBunSampler = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const clock = yield* Clock.Clock;
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      histogram.enable();
      return histogram;
    }),
    (histogram) => Effect.sync(() => histogram.disable()),
  );
  let awakeTime = NodePerfHooks.performance.now();
  let wallTime = clock.currentTimeMillisUnsafe();
  let usage = process.resourceUsage();
  let sampledAt = NodePerfHooks.performance.now();

  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.sync(() => {
    const nextAwakeTime = NodePerfHooks.performance.now();
    const nextWallTime = clock.currentTimeMillisUnsafe();
    const nextUsage = process.resourceUsage();
    // On macOS Bun's histogram clock includes sleep, but performance.now uses
    // Rust's CLOCK_UPTIME_RAW. Their elapsed-time difference excludes sleep (and
    // forward wall-clock adjustments) from warnings. Linux's histogram clock
    // already excludes host suspension.
    const nextSampledAt = NodePerfHooks.performance.now();
    const memory = process.memoryUsage();
    const readings: EventLoopReadings = {
      delayMaxNs: histogram.max,
      suspendedMs:
        platform === "darwin"
          ? Math.max(0, nextWallTime - wallTime - (nextAwakeTime - awakeTime))
          : 0,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      elapsedMs: nextSampledAt - sampledAt,
    };
    histogram.reset();
    awakeTime = nextAwakeTime;
    wallTime = nextWallTime;
    usage = nextUsage;
    sampledAt = nextSampledAt;
    return readings;
  });
});

/**
 * Returns the stall to report for one sample in ms, or undefined when there was none.
 */
export const stallMs = ({ delayMaxNs, suspendedMs }: EventLoopReadings) => {
  const delayMs = Math.round(delayMaxNs / 1e6 - suspendedMs);
  if (delayMs <= STALL_THRESHOLD_MS) return undefined;
  return delayMs;
};

// Untraced: it runs inside every 30-second tick, which already has the monitor's own span.
const recordGauges = Effect.fnUntraced(function* (readings: EventLoopReadings) {
  const cpuMs = (readings.usage.userCPUTime + readings.usage.systemCPUTime) / 1000;
  yield* Metric.update(Metrics.serverResidentBytes, readings.rssBytes);
  yield* Metric.update(Metrics.serverHeapUsedBytes, readings.heapUsedBytes);
  yield* Metric.update(
    Metrics.serverEventLoopDelayMax,
    Math.max(0, Math.round(readings.delayMaxNs / 1e6 - readings.suspendedMs)),
  );
  if (readings.elapsedMs > 0) {
    yield* Metric.update(Metrics.serverCpuUtilization, cpuMs / readings.elapsedMs);
  }
});

const encodeStallLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface StallLogOptions {
  readonly filePath: string;
  readonly maxBytes: number;
}

export const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
  stallLog: StallLogOptions,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      const stallSink = yield* Effect.try(
        () =>
          new RotatingFileSink({
            filePath: stallLog.filePath,
            maxBytes: stallLog.maxBytes,
            maxFiles: 1,
            throwOnError: true,
          }),
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("event loop stall log unavailable", {
            filePath: stallLog.filePath,
          }).pipe(Effect.as(undefined)),
        ),
      );
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        yield* recordGauges(readings);
        const delayMaxMs = stallMs(readings);
        if (delayMaxMs === undefined) return;
        const { usage, rssBytes } = readings;
        const attributes = {
          delayMaxMs,
          cpuUserMs: Math.round(usage.userCPUTime / 1000),
          cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
          majorPageFaults: usage.majorPageFault,
          minorPageFaults: usage.minorPageFault,
          involuntaryContextSwitches: usage.involuntaryContextSwitches,
          rssMb: Math.round(rssBytes / 1024 / 1024),
        };
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", { root: true, level: "Warn", attributes }),
        );
        if (stallSink !== undefined) {
          const time = DateTime.formatIso(yield* DateTime.now);
          yield* encodeStallLine({ time, ...attributes }).pipe(
            Effect.flatMap((line) => Effect.try(() => stallSink.write(`${line}\n`))),
            Effect.catch(() =>
              Effect.logWarning("event loop stall log write failed", {
                filePath: stallLog.filePath,
              }),
            ),
          );
        }
      });
      const wait = Effect.sleep(SAMPLE_INTERVAL);
      // The layer builds before the rest of the server, so the first sample covers
      // startup work such as migrations and projection bootstrap. That can block the
      // loop for seconds on a large database, so skip it rather than warn at every
      // launch.
      yield* wait.pipe(
        Effect.andThen(sample),
        Effect.andThen(wait.pipe(Effect.andThen(tick), Effect.forever)),
        Effect.forkScoped,
      );
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerWith(makeBunSampler, {
      filePath: path.join(path.dirname(serverTracePath), "event-loop-stalls.ndjson"),
      maxBytes: STALL_LOG_MAX_BYTES,
    });
  }),
);
