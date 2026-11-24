import * as NodeOS from "node:os";
import type {
  CoolerControlStatus,
  HostDiskMount,
  HostHealthSnapshot,
  HostSensorReading,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ResourceMonitorBinary from "../resourceTelemetry/ResourceMonitorBinary.ts";
import {
  type CpuCounters,
  type IoByteCounters,
  type NetByteCounters,
  evaluateHostHealthAlerts,
  parseDarwinIoregDiskIo,
  parseDarwinNetstat,
  parseDarwinSensors,
  parseDarwinSwapUsage,
  parseDarwinVmStat,
  parseDfOutput,
  parseLinuxDiskstats,
  parseLinuxHwmonDevice,
  parseLinuxMeminfo,
  parseLinuxNetDev,
  parseLinuxOsRelease,
  parseLinuxProcStat,
  parseLinuxZramStats,
} from "./HostMetricsParsers.ts";

const COOLERCONTROL_ENDPOINT = "http://127.0.0.1:11987";
const COOLERCONTROL_PROBE_TTL_MS = 60_000;
const OS_VERSION_CACHE_TTL_MS = 10 * 60_000;
// Usage per mount moves slowly, and on macOS every sample already spawns several tools.
const DISK_USAGE_CACHE_TTL_MS = 60_000;
const MAX_COOLERCONTROL_DEVICES = 32;

const CoolerControlHandshake = Schema.Struct({ shake: Schema.Boolean });
const CoolerControlDevices = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      uid: Schema.optionalKey(Schema.String),
      name: Schema.String,
      type: Schema.optionalKey(Schema.String),
    }),
  ),
});

interface Cached<A> {
  readonly value: A;
  readonly expiresAt: number;
}

export class HostHealthCollector extends Context.Service<
  HostHealthCollector,
  { readonly collect: Effect.Effect<HostHealthSnapshot> }
>()("t3/hostHealth/HostHealthCollector") {}

interface CollectorState {
  readonly sampledAt: number | null;
  readonly cpu: CpuCounters | null;
  readonly diskIo: IoByteCounters | null;
  readonly net: NetByteCounters | null;
  readonly previouslySpinningFans: ReadonlySet<string>;
  readonly cachedOsVersion: Cached<string> | null;
  readonly cachedDisks: Cached<readonly HostDiskMount[]> | null;
  readonly cachedCoolerControl: Cached<CoolerControlStatus | undefined> | null;
}

function readNodeOsCpu(): CpuCounters {
  const cpus = NodeOS.cpus();
  return cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
}

function computeRate(
  previous: number | null,
  current: number | null,
  elapsedSeconds: number,
): number | null {
  if (previous === null || current === null || elapsedSeconds <= 0) return null;
  const delta = current - previous;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.round(delta / elapsedSeconds);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const make = Effect.fn("HostHealthCollector.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const monitorBinary = yield* ResourceMonitorBinary.ResourceMonitorBinary;
  // Resolved once: it only moves when the server is reinstalled, which restarts this process.
  const monitorPath = yield* Effect.cached(monitorBinary.resolve.pipe(Effect.option));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;

  const stateRef = yield* Ref.make<CollectorState>({
    sampledAt: null,
    cpu: null,
    diskIo: null,
    net: null,
    previouslySpinningFans: new Set(),
    cachedOsVersion: null,
    cachedDisks: null,
    cachedCoolerControl: null,
  });

  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  const runCommand = (cmd: string, args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(cmd, [...args], { stdin: "ignore", stderr: "ignore" })).pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => ""),
    );

  const readOsVersion = Effect.fnUntraced(function* (nowMs: number, prev: CollectorState) {
    if (prev.cachedOsVersion !== null && nowMs < prev.cachedOsVersion.expiresAt) {
      return prev.cachedOsVersion;
    }
    let version = `${NodeOS.type()} ${NodeOS.release()}`;
    if (platform === "linux") {
      const parsed = parseLinuxOsRelease(yield* readFile("/etc/os-release"));
      if (parsed) version = parsed;
    } else if (platform === "darwin") {
      const productName = (yield* runCommand("/usr/bin/sw_vers", ["-productName"])).trim();
      const productVersion = (yield* runCommand("/usr/bin/sw_vers", ["-productVersion"])).trim();
      if (productName && productVersion) {
        version = `${productName} ${productVersion}`;
      }
    }
    return { value: version, expiresAt: nowMs + OS_VERSION_CACHE_TTL_MS };
  });

  // Strictly read-only scan of /sys/class/hwmon/hwmon* (no root, no driver hardcoding).
  const readLinuxHwmonSensors = Effect.fnUntraced(function* (): Effect.fn.Return<
    readonly HostSensorReading[]
  > {
    if (platform !== "linux") return [];
    const baseDir = "/sys/class/hwmon";
    const entries = yield* fs
      .readDirectory(baseDir)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    const hwmonDirs = entries.filter((name) => /^hwmon\d+$/.test(name)).sort();
    if (hwmonDirs.length === 0) return [];

    const perDevice = yield* Effect.forEach(
      hwmonDirs,
      (hwmonId) =>
        Effect.gen(function* () {
          const dirPath = `${baseDir}/${hwmonId}`;
          // Reading a runtime-suspended device (a hybrid laptop's idle dGPU) wakes it up.
          const power = yield* readFile(`${dirPath}/device/power/runtime_status`);
          if (power.trim() === "suspended") return [] as HostSensorReading[];
          const fileNames = yield* fs
            .readDirectory(dirPath)
            .pipe(Effect.orElseSucceed(() => [] as string[]));
          const relevant = fileNames.filter(
            (name) =>
              name === "name" ||
              /^temp\d+_(?:input|label|max|crit)$/.test(name) ||
              /^fan\d+_(?:input|label)$/.test(name) ||
              /^pwm\d+(?:_label)?$/.test(name),
          );
          if (relevant.length === 0) return [] as HostSensorReading[];
          const pairs = yield* Effect.forEach(
            relevant,
            (fileName) =>
              fs.readFileString(`${dirPath}/${fileName}`).pipe(
                Effect.map((content) => [fileName, content] as const),
                Effect.orElseSucceed(() => null),
              ),
            { concurrency: 8 },
          );
          const files = new Map<string, string>();
          for (const pair of pairs) {
            if (pair !== null) files.set(pair[0], pair[1]);
          }
          const chipName = files.get("name")?.trim() || hwmonId;
          return parseLinuxHwmonDevice({ hwmonId, chipName, files });
        }),
      { concurrency: 4 },
    );

    return perDevice.flat();
  });

  // macOS has no hwmon; the resource monitor reads IOKit and SMC in a process of its own.
  const readDarwinSensors = Effect.fnUntraced(function* (): Effect.fn.Return<
    readonly HostSensorReading[]
  > {
    const path = yield* monitorPath;
    if (path._tag === "None") return [];
    return parseDarwinSensors(yield* runCommand(path.value, ["sensors"]));
  });

  const readLinuxZram = Effect.fnUntraced(function* () {
    if (platform !== "linux") return null;
    const blockDirs = yield* fs
      .readDirectory("/sys/block")
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    const zrams = blockDirs.filter((name) => /^zram\d+$/.test(name));
    if (zrams.length === 0) return null;
    const entries = yield* Effect.forEach(
      zrams,
      (name) =>
        Effect.all({
          disksize: readFile(`/sys/block/${name}/disksize`),
          mmStat: readFile(`/sys/block/${name}/mm_stat`),
        }),
      { concurrency: 4 },
    );
    return parseLinuxZramStats(entries);
  });

  // Only GETs against a local coolercontrold: fan and pump curves stay its job, so a crash or
  // update here can never leave a cooler stuck.
  const getJson = (path: string) =>
    httpClient.get(`${COOLERCONTROL_ENDPOINT}${path}`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.timeout("500 millis"),
      Effect.orElseSucceed(() => null),
    );
  const decodeHandshake = Schema.decodeUnknownOption(CoolerControlHandshake);
  const decodeDevices = Schema.decodeUnknownOption(CoolerControlDevices);

  const probeCoolerControl = Effect.fnUntraced(function* (
    nowMs: number,
    prev: CollectorState,
  ): Effect.fn.Return<Cached<CoolerControlStatus | undefined>> {
    if (prev.cachedCoolerControl !== null && nowMs < prev.cachedCoolerControl.expiresAt) {
      return prev.cachedCoolerControl;
    }
    const expiresAt = nowMs + COOLERCONTROL_PROBE_TTL_MS;
    if (platform !== "linux") return { value: undefined, expiresAt };
    const handshake = decodeHandshake(yield* getJson("/handshake"));
    if (handshake._tag === "None" || !handshake.value.shake) return { value: undefined, expiresAt };
    const listed = decodeDevices(yield* getJson("/devices"));
    const devices =
      listed._tag === "None"
        ? []
        : listed.value.devices.slice(0, MAX_COOLERCONTROL_DEVICES).map((device, index) => ({
            id: device.uid ?? `${index}`,
            name: device.name,
            type: device.type ?? "",
          }));
    return { value: { devices }, expiresAt };
  });

  const readDisks = Effect.fnUntraced(function* (
    nowMs: number,
    prev: CollectorState,
  ): Effect.fn.Return<Cached<readonly HostDiskMount[]>> {
    if (prev.cachedDisks !== null && nowMs < prev.cachedDisks.expiresAt) return prev.cachedDisks;
    const args =
      platform === "linux"
        ? ["-Pk", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "overlay"]
        : ["-Pk"];
    const output = yield* runCommand("df", args);
    return { value: parseDfOutput(output, platform), expiresAt: nowMs + DISK_USAGE_CACHE_TTL_MS };
  });

  // Rates are deltas from the previous sample, so two samples must never interleave.
  const sampling = yield* Semaphore.make(1);

  const collectOnce = Effect.fn("HostHealthCollector.collect")(function* () {
    const prev = yield* Ref.get(stateRef);
    const nowMs = yield* Clock.currentTimeMillis;

    const cpus = NodeOS.cpus();
    const cpuModel = cpus[0]?.model?.trim() || "Unknown CPU";
    const cpuCores = cpus.length;
    const load = NodeOS.loadavg();
    const load1m = Math.round((load[0] ?? 0) * 100) / 100;
    const load5m = Math.round((load[1] ?? 0) * 100) / 100;
    const load15m = Math.round((load[2] ?? 0) * 100) / 100;

    const [
      cachedOsVersion,
      cachedDisks,
      sensors,
      cachedCoolerControl,
      cpuCounters,
      memory,
      diskIoCounters,
      netCounters,
    ] = yield* Effect.all(
      [
        readOsVersion(nowMs, prev),
        readDisks(nowMs, prev),
        platform === "darwin" ? readDarwinSensors() : readLinuxHwmonSensors(),
        probeCoolerControl(nowMs, prev),
        platform === "linux"
          ? readFile("/proc/stat").pipe(
              Effect.map((text) => parseLinuxProcStat(text) ?? readNodeOsCpu()),
            )
          : Effect.sync(readNodeOsCpu),
        Effect.gen(function* () {
          let totalBytes = NodeOS.totalmem();
          let availableBytes = NodeOS.freemem();
          let swapTotalBytes = 0;
          let swapUsedBytes = 0;
          let zram: { readonly zramTotalBytes: number; readonly zramUsedBytes: number } | null =
            null;

          if (platform === "linux") {
            const [meminfoText, zramStats] = yield* Effect.all([
              readFile("/proc/meminfo"),
              readLinuxZram(),
            ]);
            const parsed = parseLinuxMeminfo(meminfoText);
            if (parsed) {
              totalBytes = parsed.totalBytes;
              availableBytes = parsed.availableBytes;
              swapTotalBytes = parsed.swapTotalBytes;
              swapUsedBytes = parsed.swapUsedBytes;
            }
            zram = zramStats;
          } else if (platform === "darwin") {
            const [vmStatOut, swapOut] = yield* Effect.all([
              runCommand("/usr/bin/vm_stat", []),
              runCommand("/usr/sbin/sysctl", ["vm.swapusage"]),
            ]);
            availableBytes = parseDarwinVmStat(vmStatOut) ?? availableBytes;
            const parsedSwap = parseDarwinSwapUsage(swapOut);
            if (parsedSwap) {
              swapTotalBytes = parsedSwap.swapTotalBytes;
              swapUsedBytes = parsedSwap.swapUsedBytes;
            }
          }

          const clampedAvailable = Math.min(totalBytes, Math.max(0, availableBytes));
          return {
            totalBytes: Math.max(0, Math.round(totalBytes)),
            usedBytes: Math.max(0, Math.round(totalBytes - clampedAvailable)),
            availableBytes: Math.max(0, Math.round(clampedAvailable)),
            swapTotalBytes: Math.max(0, Math.round(swapTotalBytes)),
            swapUsedBytes: Math.max(0, Math.round(swapUsedBytes)),
            ...(zram !== null ? zram : {}),
          };
        }),
        platform === "linux"
          ? readFile("/proc/diskstats").pipe(Effect.map(parseLinuxDiskstats))
          : platform === "darwin"
            ? runCommand("/usr/sbin/ioreg", ["-c", "IOBlockStorageDriver", "-r", "-w", "0"]).pipe(
                Effect.map(parseDarwinIoregDiskIo),
              )
            : Effect.succeed<IoByteCounters | null>(null),
        platform === "linux"
          ? readFile("/proc/net/dev").pipe(Effect.map(parseLinuxNetDev))
          : platform === "darwin"
            ? runCommand("/usr/sbin/netstat", ["-ibn"]).pipe(Effect.map(parseDarwinNetstat))
            : Effect.succeed<NetByteCounters | null>(null),
      ],
      { concurrency: "unbounded" },
    );

    const elapsedSeconds = prev.sampledAt !== null ? (nowMs - prev.sampledAt) / 1000 : 0;

    let cpuPercent: number | null = null;
    if (prev.cpu !== null) {
      const totalDelta = cpuCounters.total - prev.cpu.total;
      const idleDelta = cpuCounters.idle - prev.cpu.idle;
      if (totalDelta > 0 && idleDelta >= 0) {
        cpuPercent = round1(Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)));
      }
    }

    const diskReadBytesPerSec = computeRate(
      prev.diskIo?.readBytes ?? null,
      diskIoCounters?.readBytes ?? null,
      elapsedSeconds,
    );
    const diskWriteBytesPerSec = computeRate(
      prev.diskIo?.writeBytes ?? null,
      diskIoCounters?.writeBytes ?? null,
      elapsedSeconds,
    );
    const netRxBytesPerSec = computeRate(
      prev.net?.rxBytes ?? null,
      netCounters?.rxBytes ?? null,
      elapsedSeconds,
    );
    const netTxBytesPerSec = computeRate(
      prev.net?.txBytes ?? null,
      netCounters?.txBytes ?? null,
      elapsedSeconds,
    );

    const disks = cachedDisks.value;
    const nextSpinningFans = new Set(prev.previouslySpinningFans);
    for (const sensor of sensors) {
      // Mac fans stop on purpose when cool, so only Linux headers count as having been spinning.
      if (platform === "linux" && sensor.kind === "fan" && sensor.value > 0) {
        nextSpinningFans.add(sensor.id);
      }
    }

    const alerts = evaluateHostHealthAlerts({
      memory,
      disks,
      sensors,
      previouslySpinningFans: prev.previouslySpinningFans,
    });

    yield* Ref.set(stateRef, {
      sampledAt: nowMs,
      cpu: cpuCounters,
      diskIo: diskIoCounters,
      net: netCounters,
      previouslySpinningFans: nextSpinningFans,
      cachedOsVersion,
      cachedDisks,
      cachedCoolerControl,
    });

    return {
      sampledAt: nowMs,
      metadata: {
        hostname: NodeOS.hostname(),
        os: platform,
        osVersion: cachedOsVersion.value,
        kernel: NodeOS.release(),
        arch: architecture,
        cpuModel,
        cpuCores,
        uptimeSeconds: Math.max(0, Math.floor(NodeOS.uptime())),
      },
      cpu: {
        utilizationPercent: cpuPercent,
        load1m,
        load5m,
        load15m,
      },
      memory,
      disks,
      diskIo: {
        readBytesPerSec: diskReadBytesPerSec,
        writeBytesPerSec: diskWriteBytesPerSec,
      },
      network: {
        rxBytesPerSec: netRxBytesPerSec,
        txBytesPerSec: netTxBytesPerSec,
      },
      sensors,
      alerts,
      ...(cachedCoolerControl.value !== undefined
        ? { coolerControl: cachedCoolerControl.value }
        : {}),
    };
  });

  return HostHealthCollector.of({ collect: sampling.withPermits(1)(collectOnce()) });
});

export const layer = Layer.effect(HostHealthCollector, make());
