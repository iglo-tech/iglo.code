// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks exposes the event loop delay histogram.
import * as NodePerfHooks from "node:perf_hooks";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

// Bun's native histogram records timer lateness, already excluding the resolution.
// It can undercount a stall by up to RESOLUTION_MS. Every stall over 3 s is caught
// with these values, at one native wakeup per second that never enters JS.
const RESOLUTION_MS = 1000;
const STALL_THRESHOLD_MS = 2000;
const SAMPLE_INTERVAL = "30 seconds";

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

  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.sync(() => {
    const nextAwakeTime = NodePerfHooks.performance.now();
    const nextWallTime = clock.currentTimeMillisUnsafe();
    const nextUsage = process.resourceUsage();
    // On macOS Bun's histogram clock includes sleep, but performance.now uses
    // Rust's CLOCK_UPTIME_RAW. Their elapsed-time difference excludes sleep (and
    // forward wall-clock adjustments) from warnings. Linux's histogram clock
    // already excludes host suspension.
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
      rssBytes: process.memoryUsage.rss(),
    };
    histogram.reset();
    awakeTime = nextAwakeTime;
    wallTime = nextWallTime;
    usage = nextUsage;
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

/**
 * Samples event loop health every 30 s and records a `server.eventLoop.stall` span
 * with a warning when the loop stalled for more than 2 s, so stalls land in
 * the local trace file and Settings > Diagnostics without OTLP. Takes the sampler
 * so tests can inject readings.
 */
export const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        const delayMaxMs = stallMs(readings);
        if (delayMaxMs === undefined) return;
        const { usage, rssBytes } = readings;
        // Root, as the stall has no caller to attach to. Warn level keeps it when
        // T3CODE_TRACE_MIN_LEVEL is raised to cut trace noise.
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", {
            root: true,
            level: "Warn",
            attributes: {
              delayMaxMs,
              cpuUserMs: Math.round(usage.userCPUTime / 1000),
              cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
              majorPageFaults: usage.majorPageFault,
              minorPageFaults: usage.minorPageFault,
              involuntaryContextSwitches: usage.involuntaryContextSwitches,
              rssMb: Math.round(rssBytes / 1024 / 1024),
            },
          }),
        );
      });
      const wait = Effect.sleep(SAMPLE_INTERVAL);
      // The layer builds before the rest of the server, so the first sample covers
      // startup work such as migrations and projection bootstrap. That can block the
      // loop for seconds on a large database, so skip it rather than warn at every
      // launch. Layers build outside any span, so this fiber retains no parent span.
      yield* wait.pipe(
        Effect.andThen(sample),
        Effect.andThen(wait.pipe(Effect.andThen(tick), Effect.forever)),
        Effect.forkScoped,
      );
    }),
  );

export const layer = layerWith(makeBunSampler);
