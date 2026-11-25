import type { HostDiskMount, HostHealthAlert, HostSensorReading } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface CpuCounters {
  readonly idle: number;
  readonly total: number;
}

export interface LinuxMeminfo {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly swapTotalBytes: number;
  readonly swapUsedBytes: number;
}

export interface IoByteCounters {
  readonly readBytes: number;
  readonly writeBytes: number;
}

export interface NetByteCounters {
  readonly rxBytes: number;
  readonly txBytes: number;
}

export function parseLinuxProcStat(text: string): CpuCounters | null {
  const match = /^cpu\s+(.+)$/m.exec(text);
  if (!match?.[1]) return null;
  const parts = match[1].trim().split(/\s+/).map(Number);
  if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const at = (index: number) => parts[index] ?? 0;
  // user nice system idle iowait irq softirq steal
  const idle = at(3) + at(4);
  const total = idle + at(0) + at(1) + at(2) + at(5) + at(6) + at(7);
  return total > 0 ? { idle, total } : null;
}

export function parseLinuxMeminfo(text: string): LinuxMeminfo | null {
  const readKiB = (field: string): number | null => {
    const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
    if (!match?.[1]) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value * 1024 : null;
  };
  const totalBytes = readKiB("MemTotal");
  if (totalBytes === null || totalBytes <= 0) return null;
  const availableBytes =
    readKiB("MemAvailable") ??
    (readKiB("MemFree") ?? 0) + (readKiB("Buffers") ?? 0) + (readKiB("Cached") ?? 0);
  const swapTotalBytes = readKiB("SwapTotal") ?? 0;
  const swapFreeBytes = readKiB("SwapFree") ?? swapTotalBytes;
  return {
    totalBytes,
    availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)),
    swapTotalBytes: Math.max(0, swapTotalBytes),
    swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
  };
}

export function parseLinuxZramStats(
  entries: ReadonlyArray<{ readonly disksize: string; readonly mmStat: string }>,
): { readonly zramTotalBytes: number; readonly zramUsedBytes: number } | null {
  let totalBytes = 0;
  let usedBytes = 0;
  let found = false;
  for (const entry of entries) {
    const disksize = Number(entry.disksize.trim());
    if (!Number.isFinite(disksize) || disksize <= 0) continue;
    const mmParts = entry.mmStat.trim().split(/\s+/).map(Number);
    // mm_stat columns: orig_data_size compr_data_size mem_used_total ...
    const memUsedTotal = mmParts[2] ?? mmParts[0] ?? 0;
    if (!Number.isFinite(memUsedTotal)) continue;
    totalBytes += Math.floor(disksize);
    usedBytes += Math.max(0, Math.floor(memUsedTotal));
    found = true;
  }
  return found ? { zramTotalBytes: totalBytes, zramUsedBytes: usedBytes } : null;
}

const LINUX_WHOLE_DISK_PATTERN =
  /^(?:sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|dasd[a-z]+)$/;
const LINUX_IGNORED_DISK_PATTERN = /^(?:loop\d+|ram\d+|zram\d+|sr\d+|fd\d+)$/;

export function parseLinuxDiskstats(text: string): IoByteCounters | null {
  let wholeDiskReadSectors = 0;
  let wholeDiskWriteSectors = 0;
  let matchedWholeDisk = false;
  let fallbackReadSectors = 0;
  let fallbackWriteSectors = 0;
  let matchedFallback = false;

  for (const rawLine of text.split("\n")) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const name = parts[2];
    if (!name || LINUX_IGNORED_DISK_PATTERN.test(name)) continue;
    const sectorsRead = Number(parts[5]);
    const sectorsWritten = Number(parts[9]);
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue;
    if (LINUX_WHOLE_DISK_PATTERN.test(name)) {
      wholeDiskReadSectors += sectorsRead;
      wholeDiskWriteSectors += sectorsWritten;
      matchedWholeDisk = true;
    } else if (!name.startsWith("dm-")) {
      fallbackReadSectors += sectorsRead;
      fallbackWriteSectors += sectorsWritten;
      matchedFallback = true;
    }
  }

  if (matchedWholeDisk) {
    return {
      readBytes: wholeDiskReadSectors * 512,
      writeBytes: wholeDiskWriteSectors * 512,
    };
  }
  if (matchedFallback) {
    return {
      readBytes: fallbackReadSectors * 512,
      writeBytes: fallbackWriteSectors * 512,
    };
  }
  return null;
}

export function parseLinuxNetDev(text: string): NetByteCounters | null {
  let rxBytes = 0;
  let txBytes = 0;
  let found = false;
  for (const rawLine of text.split("\n")) {
    const colonIndex = rawLine.indexOf(":");
    if (colonIndex === -1) continue;
    const iface = rawLine.slice(0, colonIndex).trim();
    if (!iface || iface === "lo") continue;
    const fields = rawLine
      .slice(colonIndex + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 9) continue;
    const rx = fields[0];
    const tx = fields[8];
    if (rx === undefined || tx === undefined || !Number.isFinite(rx) || !Number.isFinite(tx)) {
      continue;
    }
    rxBytes += rx;
    txBytes += tx;
    found = true;
  }
  return found ? { rxBytes, txBytes } : null;
}

export function parseLinuxOsRelease(text: string): string | null {
  const pretty = /^PRETTY_NAME=(?:"([^"]+)"|'([^']+)'|(.+))$/m.exec(text);
  const value = (pretty?.[1] ?? pretty?.[2] ?? pretty?.[3] ?? "").trim();
  return value.length > 0 ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function parseLinuxHwmonDevice(input: {
  readonly hwmonId: string;
  readonly chipName: string;
  readonly files: ReadonlyMap<string, string>;
}): readonly HostSensorReading[] {
  const chip = input.chipName.trim() || input.hwmonId;
  const temps: Array<{ readonly index: number; readonly reading: HostSensorReading }> = [];
  const fans: Array<{ readonly index: number; readonly reading: HostSensorReading }> = [];
  const pwms: Array<{ readonly index: number; readonly reading: HostSensorReading }> = [];

  for (const [filename, rawValue] of input.files) {
    const tempMatch = /^temp(\d+)_input$/.exec(filename);
    if (tempMatch?.[1]) {
      const idx = Number(tempMatch[1]);
      const milliC = Number(rawValue.trim());
      if (!Number.isFinite(milliC)) continue;
      const celsius = round1(milliC / 1000);
      if (celsius < -50 || celsius > 200) continue;
      const label = input.files.get(`temp${idx}_label`)?.trim() || `temp${idx}`;
      const maxRaw = input.files.get(`temp${idx}_max`)?.trim();
      const critRaw = input.files.get(`temp${idx}_crit`)?.trim();
      const maxC = maxRaw !== undefined && maxRaw !== "" ? round1(Number(maxRaw) / 1000) : NaN;
      const critC = critRaw !== undefined && critRaw !== "" ? round1(Number(critRaw) / 1000) : NaN;
      temps.push({
        index: idx,
        reading: {
          id: `${input.hwmonId}:temp${idx}`,
          chip,
          kind: "temperature",
          label,
          value: celsius,
          unit: "celsius",
          ...(Number.isFinite(maxC) && maxC > 0 && maxC <= 200 ? { highThreshold: maxC } : {}),
          ...(Number.isFinite(critC) && critC > 0 && critC <= 200
            ? { criticalThreshold: critC }
            : {}),
        },
      });
      continue;
    }

    const fanMatch = /^fan(\d+)_input$/.exec(filename);
    if (fanMatch?.[1]) {
      const idx = Number(fanMatch[1]);
      const rpm = Math.round(Number(rawValue.trim()));
      if (!Number.isFinite(rpm) || rpm < 0) continue;
      const label = input.files.get(`fan${idx}_label`)?.trim() || `fan${idx}`;
      fans.push({
        index: idx,
        reading: {
          id: `${input.hwmonId}:fan${idx}`,
          chip,
          kind: "fan",
          label,
          value: rpm,
          unit: "rpm",
        },
      });
      continue;
    }

    const pwmMatch = /^pwm(\d+)$/.exec(filename);
    if (pwmMatch?.[1]) {
      const idx = Number(pwmMatch[1]);
      const rawPwm = Number(rawValue.trim());
      if (!Number.isFinite(rawPwm) || rawPwm < 0 || rawPwm > 255) continue;
      const percent = round1((rawPwm / 255) * 100);
      const label = input.files.get(`pwm${idx}_label`)?.trim() || `pwm${idx}`;
      pwms.push({
        index: idx,
        reading: {
          id: `${input.hwmonId}:pwm${idx}`,
          chip,
          kind: "pwm",
          label,
          value: percent,
          unit: "percent",
        },
      });
    }
  }

  temps.sort((a, b) => a.index - b.index);
  fans.sort((a, b) => a.index - b.index);
  pwms.sort((a, b) => a.index - b.index);

  return [
    ...temps.map((entry) => entry.reading),
    ...fans.map((entry) => entry.reading),
    ...pwms.map((entry) => entry.reading),
  ];
}

// Apple silicon names dozens of die sensors; one reading per family is what a person reads.
const DARWIN_SENSOR_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^pACC/i, "CPU performance cores"],
  [/^eACC/i, "CPU efficiency cores"],
  [/^GPU/i, "GPU"],
  [/^ANE/i, "Neural Engine"],
  [/^(?:SOC|PMGR)/i, "SoC"],
  [/^ISP/i, "Image processor"],
  [/^NAND/i, "SSD"],
  [/^PMU/i, "Power management"],
  [/battery|gas gauge/i, "Battery"],
];
// Apple silicon dies idle near 40 °C and throttle around 105 °C, far above Linux defaults.
const DARWIN_TEMP_HIGH_C = 95;
const DARWIN_TEMP_CRITICAL_C = 105;

const DarwinSensorsOutput = Schema.Struct({
  temperatures: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      celsius: Schema.Number,
      critical: Schema.optionalKey(Schema.Number),
    }),
  ),
  fans: Schema.Array(Schema.Struct({ index: Schema.Number, rpm: Schema.Number })),
});
const decodeDarwinSensors = Schema.decodeUnknownOption(Schema.fromJsonString(DarwinSensorsOutput));

/** The resource monitor's `sensors` line, as the hottest sensor of each family and each fan. */
export function parseDarwinSensors(output: string): readonly HostSensorReading[] {
  const decoded = decodeDarwinSensors(output.trim());
  if (decoded._tag === "None") return [];
  const hottest = new Map<string, HostSensorReading>();
  for (const sensor of decoded.value.temperatures) {
    const family =
      DARWIN_SENSOR_FAMILIES.find(([pattern]) => pattern.test(sensor.label))?.[1] ?? sensor.label;
    const value = round1(sensor.celsius);
    const current = hottest.get(family);
    if (current !== undefined && current.value >= value) continue;
    const critical = sensor.critical ?? DARWIN_TEMP_CRITICAL_C;
    hottest.set(family, {
      id: `smc:temp:${family}`,
      chip: "Temperatures",
      kind: "temperature",
      label: family,
      value,
      unit: "celsius",
      highThreshold: Math.min(DARWIN_TEMP_HIGH_C, critical),
      criticalThreshold: critical,
    });
  }
  const temperatures = [...hottest.values()].sort((a, b) => a.label.localeCompare(b.label));
  const fans = decoded.value.fans.map((fan): HostSensorReading => ({
    id: `smc:fan${fan.index}`,
    chip: "AppleSMC",
    kind: "fan",
    label: `Fan ${fan.index + 1}`,
    value: Math.round(fan.rpm),
    unit: "rpm",
  }));
  return [...temperatures, ...fans];
}

const IGNORED_FILESYSTEMS = new Set([
  "tmpfs",
  "devtmpfs",
  "devfs",
  "squashfs",
  "overlay",
  "efivarfs",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "udev",
  "none",
]);

function isIgnoredMount(
  filesystem: string,
  mountPoint: string,
  platform: NodeJS.Platform,
): boolean {
  if (IGNORED_FILESYSTEMS.has(filesystem)) return true;
  if (filesystem.startsWith("map ") || filesystem.startsWith("portal")) return true;
  if (mountPoint.startsWith("/snap/") || mountPoint.startsWith("/run/") || mountPoint === "/dev") {
    return true;
  }
  if (platform === "darwin") {
    if (mountPoint.startsWith("/System/Volumes/")) return true;
    if (mountPoint === "/Volumes/Recovery") return true;
  }
  if (platform === "linux") {
    if (mountPoint === "/boot/efi" || mountPoint.startsWith("/sys/")) return true;
  }
  return false;
}

const DARWIN_DATA_VOLUME = "/System/Volumes/Data";

export function parseDfOutput(output: string, platform: NodeJS.Platform): readonly HostDiskMount[] {
  const lines = output.split("\n").slice(1);
  const byMount = new Map<string, HostDiskMount>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // POSIX df -Pk columns: Filesystem 1024-blocks Used Available Capacity% Mounted on
    const match = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line);
    if (!match) continue;
    const filesystem = match[1]?.trim() ?? "";
    const totalBlocks = Number(match[2]);
    const usedBlocks = Number(match[3]);
    const availBlocks = Number(match[4]);
    const mountPoint = match[6]?.trim() ?? "";
    if (
      !filesystem ||
      !mountPoint ||
      !Number.isFinite(totalBlocks) ||
      totalBlocks <= 0 ||
      !Number.isFinite(usedBlocks) ||
      !Number.isFinite(availBlocks)
    ) {
      continue;
    }
    // macOS mounts a sealed system snapshot at /, so what the user stores is on the Data volume.
    const shownAt = platform === "darwin" && mountPoint === DARWIN_DATA_VOLUME ? "/" : mountPoint;
    if (shownAt === mountPoint && isIgnoredMount(filesystem, mountPoint, platform)) continue;
    if (platform === "darwin" && mountPoint === "/" && byMount.has("/")) continue;
    const totalBytes = totalBlocks * 1024;
    const usedBytes = Math.min(totalBytes, Math.max(0, usedBlocks * 1024));
    const availableBytes = Math.min(totalBytes, Math.max(0, availBlocks * 1024));
    const usedPercent = round1((usedBytes / totalBytes) * 100);
    byMount.set(shownAt, {
      mountPoint: shownAt,
      filesystem,
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent,
    });
  }

  return [...byMount.values()].sort((a, b) => {
    if (a.mountPoint === "/") return -1;
    if (b.mountPoint === "/") return 1;
    return a.mountPoint.localeCompare(b.mountPoint);
  });
}

export function parseDarwinVmStat(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

export function parseDarwinSwapUsage(
  output: string,
): { readonly swapTotalBytes: number; readonly swapUsedBytes: number } | null {
  const parseSize = (token: string | undefined, unit: string | undefined): number | null => {
    if (!token) return null;
    const value = Number(token);
    if (!Number.isFinite(value) || value < 0) return null;
    switch (unit?.toUpperCase()) {
      case "G":
        return Math.round(value * 1024 * 1024 * 1024);
      case "M":
        return Math.round(value * 1024 * 1024);
      case "K":
        return Math.round(value * 1024);
      default:
        return Math.round(value);
    }
  };
  const totalMatch = /total\s*=\s*(\d+(?:\.\d+)?)([KMGT])?/i.exec(output);
  const usedMatch = /used\s*=\s*(\d+(?:\.\d+)?)([KMGT])?/i.exec(output);
  const swapTotalBytes = parseSize(totalMatch?.[1], totalMatch?.[2]);
  const swapUsedBytes = parseSize(usedMatch?.[1], usedMatch?.[2]);
  if (swapTotalBytes === null || swapUsedBytes === null) return null;
  return { swapTotalBytes, swapUsedBytes: Math.min(swapTotalBytes, swapUsedBytes) };
}

export function parseDarwinNetstat(output: string): NetByteCounters | null {
  let rxBytes = 0;
  let txBytes = 0;
  let found = false;
  for (const rawLine of output.split("\n").slice(1)) {
    const parts = rawLine.trim().split(/\s+/);
    // Link-layer lines have `<Link#N>` at index 2; trailing 7 columns are:
    // Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    if (parts.length < 10) continue;
    const iface = parts[0];
    const network = parts[2];
    if (!iface || iface.startsWith("lo") || !network?.startsWith("<Link#")) continue;
    const ibytes = Number(parts[parts.length - 5]);
    const obytes = Number(parts[parts.length - 2]);
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue;
    rxBytes += ibytes;
    txBytes += obytes;
    found = true;
  }
  return found ? { rxBytes, txBytes } : null;
}

export function parseDarwinIoregDiskIo(output: string): IoByteCounters | null {
  let readBytes = 0;
  let writeBytes = 0;
  let found = false;
  for (const match of output.matchAll(/"Bytes \(Read\)"=(\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      readBytes += value;
      found = true;
    }
  }
  for (const match of output.matchAll(/"Bytes \(Write\)"=(\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      writeBytes += value;
      found = true;
    }
  }
  return found ? { readBytes, writeBytes } : null;
}

// A pump or CPU fan at 0 RPM is an emergency even on the first sample; other fans warn only
// after they were seen spinning, since many boards report idle headers as 0.
const CRITICAL_FAN_NAME_PATTERN = /(?:pump|aio|water|liquid|cpu)/i;
const DEFAULT_TEMP_HIGH_C = 80;
const DEFAULT_TEMP_CRITICAL_C = 90;

export function evaluateHostHealthAlerts(input: {
  readonly memory: { readonly totalBytes: number; readonly usedBytes: number };
  readonly disks: ReadonlyArray<HostDiskMount>;
  readonly sensors: ReadonlyArray<HostSensorReading>;
  readonly previouslySpinningFans: ReadonlySet<string>;
}): readonly HostHealthAlert[] {
  const alerts: HostHealthAlert[] = [];

  if (input.memory.totalBytes > 0) {
    const percent = round1((input.memory.usedBytes / input.memory.totalBytes) * 100);
    if (percent >= 90) {
      const critical = percent >= 97;
      alerts.push({
        id: "memory",
        severity: critical ? "critical" : "warning",
        kind: "memory",
        subject: "",
        value: percent,
        threshold: critical ? 97 : 90,
      });
    }
  }

  for (const disk of input.disks) {
    if (disk.usedPercent < 85) continue;
    const critical = disk.usedPercent >= 95;
    alerts.push({
      id: `disk:${disk.mountPoint}`,
      severity: critical ? "critical" : "warning",
      kind: "disk",
      subject: disk.mountPoint,
      value: disk.usedPercent,
      threshold: critical ? 95 : 85,
    });
  }

  for (const sensor of input.sensors) {
    const subject = `${sensor.chip} ${sensor.label}`;
    if (sensor.kind === "temperature") {
      const crit = sensor.criticalThreshold ?? DEFAULT_TEMP_CRITICAL_C;
      const high =
        sensor.highThreshold !== undefined && sensor.highThreshold < crit
          ? sensor.highThreshold
          : Math.min(DEFAULT_TEMP_HIGH_C, crit);
      if (sensor.value < high) continue;
      const critical = sensor.value >= crit;
      alerts.push({
        id: `temp:${sensor.id}`,
        severity: critical ? "critical" : "warning",
        kind: "temperature",
        subject,
        value: sensor.value,
        threshold: critical ? crit : high,
      });
    } else if (sensor.kind === "fan" && sensor.value === 0) {
      const essential = CRITICAL_FAN_NAME_PATTERN.test(sensor.label);
      if (!essential && !input.previouslySpinningFans.has(sensor.id)) continue;
      alerts.push({
        id: `fan:${sensor.id}`,
        severity: essential ? "critical" : "warning",
        kind: "fan",
        subject,
        value: 0,
      });
    }
  }

  return alerts;
}
