import type { HostHealthSnapshot } from "@t3tools/contracts";

/** A healthy Linux sample at `sampledAt`, with the values a test cares about overridden. */
export function makeSnapshot(
  sampledAt: number,
  overrides: {
    readonly cpu?: number | null;
    readonly memoryUsed?: number;
    readonly rx?: number | null;
    readonly temp?: number;
  } = {},
): HostHealthSnapshot {
  return {
    sampledAt,
    metadata: {
      hostname: "box",
      os: "linux",
      osVersion: "Ubuntu 24.04 LTS",
      kernel: "6.8.0",
      arch: "x64",
      cpuModel: "Ryzen",
      cpuCores: 16,
      uptimeSeconds: 100,
    },
    cpu: {
      utilizationPercent: overrides.cpu === undefined ? 10 : overrides.cpu,
      load1m: 1,
      load5m: 1,
      load15m: 1,
    },
    memory: {
      totalBytes: 1000,
      usedBytes: overrides.memoryUsed ?? 500,
      availableBytes: 1000 - (overrides.memoryUsed ?? 500),
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    },
    disks: [],
    diskIo: { readBytesPerSec: null, writeBytesPerSec: null },
    network: { rxBytesPerSec: overrides.rx === undefined ? 100 : overrides.rx, txBytesPerSec: 0 },
    sensors:
      overrides.temp === undefined
        ? []
        : [
            {
              id: "hwmon0:temp1",
              chip: "k10temp",
              kind: "temperature",
              label: "Tctl",
              value: overrides.temp,
              unit: "celsius",
            },
          ],
    alerts: [],
  };
}
