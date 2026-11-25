import type { HostHealthHistory, HostHealthRange, HostHealthSnapshot } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CpuIcon,
  GaugeIcon,
  HardDriveIcon,
  MemoryStickIcon,
  NetworkIcon,
  ServerIcon,
  ThermometerIcon,
} from "lucide-react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { DotMatrixChart, type DotMatrixSeries } from "./DotMatrixChart";
import type { FleetHost } from "./fleetHosts";
import { HealthCard } from "./HealthCard";
import { HEALTH_TONES, type HealthTone, SECONDARY_SERIES, usageFillClass } from "./healthTones";
import {
  formatPercent,
  formatRate,
  formatSensorValue,
  formatUptime,
  HOST_HEALTH_RANGE_MS,
  hostHealthAlertText,
  hottestSensor,
  sensorsByChip,
  usedPercent,
} from "./hostHealthFormat";
import { HostStatusBadge } from "./HostStatusBadge";
import { useHostHealthHistory, useHostHealthSnapshot } from "./useHostHealth";

const CHART_ROWS = 12;

export function HostHealthDetail({
  host,
  range,
}: {
  readonly host: FleetHost;
  readonly range: HostHealthRange;
}) {
  const health = useHostHealthSnapshot(host);
  const history = useHostHealthHistory(host, range);
  const snapshot = health.data;

  if (host.availability !== "live") {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        <T>This machine's health cannot be read right now.</T>
      </p>
    );
  }
  if (snapshot === null) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        {health.error ?? <T>Reading health…</T>}
      </p>
    );
  }
  const charts = historyCharts(history.data, snapshot);
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6">
      <HostHeading host={host} snapshot={snapshot} />
      {snapshot.alerts.length === 0 ? null : <HostAlerts snapshot={snapshot} />}
      {charts === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {history.error ?? <T>Loading history…</T>}
        </p>
      ) : charts.points.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No history yet. Samples are taken every 10 seconds while the server runs.</T>
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <CpuCard snapshot={snapshot} charts={charts} />
        <MemoryCard snapshot={snapshot} charts={charts} />
        <LoadCard snapshot={snapshot} charts={charts} />
        <DiskIoCard snapshot={snapshot} charts={charts} />
        <NetworkCard snapshot={snapshot} charts={charts} />
        {hottestSensor(snapshot.sensors) === null ? null : (
          <TemperatureCard snapshot={snapshot} charts={charts} />
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <MemoryByTypeCard snapshot={snapshot} />
        <StorageCard snapshot={snapshot} />
        <AboutCard host={host} snapshot={snapshot} />
      </div>
      {snapshot.sensors.length === 0 ? null : <SensorsCard snapshot={snapshot} />}
      {snapshot.coolerControl === undefined ? null : <CoolerControlCard snapshot={snapshot} />}
    </div>
  );
}

interface HistoryCharts {
  readonly points: HostHealthHistory["points"];
  readonly timestamps: ReadonlyArray<number>;
  readonly fromMs: number;
  readonly toMs: number;
  readonly maxGapMs: number;
}

function historyCharts(
  history: HostHealthHistory | null,
  snapshot: HostHealthSnapshot,
): HistoryCharts | null {
  if (history === null) return null;
  const points = history.points;
  const timestamps = points.map((point) => point.timestamp);
  const toMs = Math.max(snapshot.sampledAt, timestamps.at(-1) ?? 0);
  return {
    points,
    timestamps,
    fromMs: toMs - HOST_HEALTH_RANGE_MS[history.range],
    toMs,
    // A missed sample or two is noise; a longer silence means the server was down.
    maxGapMs: history.resolutionSeconds * 1_000 * 3,
  };
}

function HistoryChart({
  charts,
  tone,
  series,
  fixedMax,
  minMax,
  formatValue,
}: {
  readonly charts: HistoryCharts | null;
  readonly tone: HealthTone;
  readonly series: (points: HostHealthHistory["points"]) => ReadonlyArray<DotMatrixSeries>;
  readonly fixedMax?: number;
  readonly minMax?: number;
  readonly formatValue: (value: number) => string;
}) {
  if (charts === null || charts.points.length === 0) return null;
  return (
    <DotMatrixChart
      tone={tone}
      timestamps={charts.timestamps}
      fromMs={charts.fromMs}
      toMs={charts.toMs}
      maxGapMs={charts.maxGapMs}
      rows={CHART_ROWS}
      series={series(charts.points)}
      formatValue={formatValue}
      {...(fixedMax === undefined ? {} : { fixedMax })}
      {...(minMax === undefined ? {} : { minMax })}
    />
  );
}

function HostHeading({
  host,
  snapshot,
}: {
  readonly host: FleetHost;
  readonly snapshot: HostHealthSnapshot;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { metadata } = snapshot;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
        <ServerIcon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-lg font-semibold text-foreground">{metadata.hostname}</h2>
        <p className="truncate text-xs text-muted-foreground">
          {[
            metadata.osVersion,
            metadata.cpuModel,
            gt("up {uptime}", { uptime: formatUptime(metadata.uptimeSeconds, resolve) }),
            host.viaLabel === null
              ? null
              : gt("read through {environment}", { environment: host.viaLabel }),
          ]
            .filter((part) => part !== null && part !== "")
            .join(" · ")}
        </p>
      </div>
      <HostStatusBadge snapshot={snapshot} />
    </div>
  );
}

function HostAlerts({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const resolve = useMessages();
  return (
    <ul className="flex flex-col gap-1.5">
      {snapshot.alerts.map((alert) => (
        <li
          key={alert.id}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3 py-2 text-xs",
            alert.severity === "critical"
              ? "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16"
              : "bg-warning/8 text-warning-foreground dark:bg-warning/16",
          )}
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          {hostHealthAlertText(alert, resolve)}
        </li>
      ))}
    </ul>
  );
}

interface CardProps {
  readonly snapshot: HostHealthSnapshot;
  readonly charts: HistoryCharts | null;
}

function CpuCard({ snapshot, charts }: CardProps) {
  const gt = useGT();
  const tone = HEALTH_TONES.cpu;
  const { cpu, metadata } = snapshot;
  const hottest = hottestSensor(snapshot.sensors);
  return (
    <HealthCard.Root>
      <HealthCard.Header
        tone={tone}
        icon={CpuIcon}
        title={gt("CPU")}
        aside={gt("{count, plural, one {{count} core} other {{count} cores}}", {
          count: metadata.cpuCores,
        })}
      />
      <HealthCard.Hero
        label={gt("Now", { $context: "current host health values" })}
        value={formatPercent(cpu.utilizationPercent)}
      />
      <HealthCard.Stats>
        <HealthCard.Stat
          label={gt("Load", { $context: "system load average" })}
          value={cpu.load1m.toFixed(2)}
        />
        <HealthCard.Stat
          label={gt("Per core", { $context: "load average divided by cores" })}
          value={metadata.cpuCores > 0 ? (cpu.load1m / metadata.cpuCores).toFixed(2) : "–"}
        />
        <HealthCard.Stat
          label={gt("Temperature")}
          value={hottest === null ? "–" : `${hottest.value.toFixed(0)} °C`}
        />
      </HealthCard.Stats>
      <HistoryChart
        charts={charts}
        tone={tone}
        fixedMax={100}
        formatValue={formatPercent}
        series={(points) => [
          {
            label: gt("CPU"),
            values: points.map((point) => point.cpuPercent),
            dotClassName: tone.dot,
            swatchClassName: tone.swatch,
          },
        ]}
      />
    </HealthCard.Root>
  );
}

function MemoryCard({ snapshot, charts }: CardProps) {
  const gt = useGT();
  const tone = HEALTH_TONES.memory;
  const { memory } = snapshot;
  const total =
    charts === null ? 0 : Math.max(0, ...charts.points.map((point) => point.memoryTotalBytes));
  return (
    <HealthCard.Root>
      <HealthCard.Header
        tone={tone}
        icon={MemoryStickIcon}
        title={gt("Memory")}
        aside={formatPercent(usedPercent(memory.usedBytes, memory.totalBytes))}
      />
      <HealthCard.Hero
        label={gt("In use of {total}", { total: formatBytes(memory.totalBytes) })}
        value={formatBytes(memory.usedBytes)}
      />
      <HealthCard.Stats>
        <HealthCard.Stat label={gt("Available")} value={formatBytes(memory.availableBytes)} />
        <HealthCard.Stat
          label={gt("Swap")}
          value={memory.swapTotalBytes > 0 ? formatBytes(memory.swapUsedBytes) : "–"}
        />
        <HealthCard.Stat
          label="zram"
          value={memory.zramUsedBytes === undefined ? "–" : formatBytes(memory.zramUsedBytes)}
        />
      </HealthCard.Stats>
      <HistoryChart
        charts={charts}
        tone={tone}
        formatValue={formatBytes}
        {...(total > 0 ? { minMax: total } : {})}
        series={(points) => [
          {
            label: gt("Used", { $context: "memory in use" }),
            values: points.map((point) => point.memoryUsedBytes),
            dotClassName: tone.dot,
            swatchClassName: tone.swatch,
          },
          {
            label: gt("Swap"),
            values: points.map((point) => point.swapUsedBytes),
            dotClassName: SECONDARY_SERIES.amber.dot,
            swatchClassName: SECONDARY_SERIES.amber.swatch,
          },
        ]}
      />
    </HealthCard.Root>
  );
}

function LoadCard({ snapshot, charts }: CardProps) {
  const gt = useGT();
  const tone = HEALTH_TONES.load;
  const { cpu, metadata } = snapshot;
  const pressure = metadata.cpuCores > 0 ? cpu.load1m / metadata.cpuCores : null;
  return (
    <HealthCard.Root>
      <HealthCard.Header
        tone={tone}
        icon={ActivityIcon}
        title={gt("Load average")}
        aside={
          pressure === null
            ? undefined
            : pressure >= 1
              ? gt("Busy", { $context: "system load level" })
              : pressure >= 0.7
                ? gt("Moderate", { $context: "system load level" })
                : gt("Light", { $context: "system load level" })
        }
      />
      <HealthCard.Hero label={gt("Last minute")} value={cpu.load1m.toFixed(2)} />
      <HealthCard.Stats>
        <HealthCard.Stat label={gt("5 minutes")} value={cpu.load5m.toFixed(2)} />
        <HealthCard.Stat label={gt("15 minutes")} value={cpu.load15m.toFixed(2)} />
        <HealthCard.Stat label={gt("Cores")} value={metadata.cpuCores} />
      </HealthCard.Stats>
      <HistoryChart
        charts={charts}
        tone={tone}
        formatValue={(value) => value.toFixed(2)}
        series={(points) => [
          {
            label: gt("Load", { $context: "system load average" }),
            values: points.map((point) => point.load1m),
            dotClassName: tone.dot,
            swatchClassName: tone.swatch,
          },
        ]}
      />
    </HealthCard.Root>
  );
}

function DiskIoCard({ snapshot, charts }: CardProps) {
  const gt = useGT();
  const tone = HEALTH_TONES.disk;
  const root = snapshot.disks[0] ?? null;
  return (
    <HealthCard.Root>
      <HealthCard.Header tone={tone} icon={HardDriveIcon} title={gt("Disk")} />
      {root === null ? (
        <HealthCard.Hero
          label={gt("Reading", { $context: "disk read rate" })}
          value={formatRate(snapshot.diskIo.readBytesPerSec)}
        />
      ) : (
        <HealthCard.Hero
          label={gt("Free of {total} on {mount}", {
            total: formatBytes(root.totalBytes),
            mount: root.mountPoint,
          })}
          value={formatBytes(root.availableBytes)}
        />
      )}
      <HealthCard.Stats>
        <HealthCard.Stat
          label={gt("Reading", { $context: "disk read rate" })}
          value={formatRate(snapshot.diskIo.readBytesPerSec)}
        />
        <HealthCard.Stat
          label={gt("Writing", { $context: "disk write rate" })}
          value={formatRate(snapshot.diskIo.writeBytesPerSec)}
        />
        <HealthCard.Stat
          label={gt("Used", { $context: "disk space used" })}
          value={root === null ? "–" : formatPercent(root.usedPercent)}
        />
      </HealthCard.Stats>
      <HistoryChart
        charts={charts}
        tone={tone}
        formatValue={formatRate}
        series={(points) => [
          {
            label: gt("Read", { $context: "disk bytes read" }),
            values: points.map((point) => point.diskReadBytesPerSec),
            dotClassName: tone.dot,
            swatchClassName: tone.swatch,
          },
          {
            label: gt("Write", { $context: "disk bytes written" }),
            values: points.map((point) => point.diskWriteBytesPerSec),
            dotClassName: SECONDARY_SERIES.blue.dot,
            swatchClassName: SECONDARY_SERIES.blue.swatch,
          },
        ]}
      />
    </HealthCard.Root>
  );
}

function NetworkCard({ snapshot, charts }: CardProps) {
  const gt = useGT();
  const tone = HEALTH_TONES.network;
  let peak: number | null = null;
  for (const point of charts?.points ?? []) {
    const rate = point.netRxBytesPerSec;
    if (rate !== null && (peak === null || rate > peak)) peak = rate;
  }
  return (
    <HealthCard.Root>
      <HealthCard.Header tone={tone} icon={NetworkIcon} title={gt("Network")} />
      <HealthCard.Hero
        label={gt("Downloading", { $context: "network download rate" })}
        value={formatRate(snapshot.network.rxBytesPerSec)}
      />
      <HealthCard.Stats>
        <HealthCard.Stat
          label={gt("Uploading", { $context: "network upload rate" })}
          value={formatRate(snapshot.network.txBytesPerSec)}
        />
        <HealthCard.Stat
          label={gt("Peak in", { $context: "highest download rate in the chart range" })}
          value={formatRate(peak)}
        />
        <HealthCard.Stat
          label={gt("Total now", { $context: "download plus upload rate" })}
          value={formatRate(
            snapshot.network.rxBytesPerSec === null && snapshot.network.txBytesPerSec === null
              ? null
              : (snapshot.network.rxBytesPerSec ?? 0) + (snapshot.network.txBytesPerSec ?? 0),
          )}
        />
      </HealthCard.Stats>
      <HistoryChart
        charts={charts}
        tone={tone}
        formatValue={formatRate}
        series={(points) => [
          {
            label: gt("In", { $context: "network traffic received" }),
            values: points.map((point) => point.netRxBytesPerSec),
            dotClassName: tone.dot,
            swatchClassName: tone.swatch,
          },
          {
            label: gt("Out", { $context: "network traffic sent" }),
            values: points.map((point) => point.netTxBytesPerSec),
            dotClassName: SECONDARY_SERIES.blue.dot,
            swatchClassName: SECONDARY_SERIES.blue.swatch,
          },
        ]}
      />
    </HealthCard.Root>
  );
}

function TemperatureCard({ snapshot, charts }: CardProps) {
  const gt = useGT();
  const tone = HEALTH_TONES.temperature;
  const hottest = hottestSensor(snapshot.sensors);
  const temperatures = snapshot.sensors.filter((sensor) => sensor.kind === "temperature");
  const fans = snapshot.sensors.filter((sensor) => sensor.kind === "fan");
  const average =
    temperatures.length === 0
      ? null
      : temperatures.reduce((sum, sensor) => sum + sensor.value, 0) / temperatures.length;
  return (
    <HealthCard.Root>
      <HealthCard.Header
        tone={tone}
        icon={ThermometerIcon}
        title={gt("Temperature")}
        aside={
          hottest === null
            ? undefined
            : /^temp\d+$/.test(hottest.label)
              ? `${hottest.chip} · ${hottest.label}`
              : hottest.label
        }
      />
      <HealthCard.Hero
        label={gt("Hottest sensor")}
        value={hottest === null ? "–" : `${hottest.value.toFixed(0)} °C`}
      />
      <HealthCard.Stats>
        <HealthCard.Stat
          label={gt("Average", { $context: "average temperature across sensors" })}
          value={average === null ? "–" : `${average.toFixed(0)} °C`}
        />
        <HealthCard.Stat
          label={gt("Limit", { $context: "temperature threshold" })}
          value={
            hottest?.criticalThreshold === undefined && hottest?.highThreshold === undefined
              ? "–"
              : `${(hottest.criticalThreshold ?? hottest.highThreshold ?? 0).toFixed(0)} °C`
          }
        />
        <HealthCard.Stat label={gt("Fans")} value={fans.length === 0 ? "–" : fans.length} />
      </HealthCard.Stats>
      <HistoryChart
        charts={charts}
        tone={tone}
        formatValue={(value) => `${value.toFixed(0)} °C`}
        series={(points) => [
          {
            label: gt("Peak", { $context: "highest temperature" }),
            values: points.map((point) => point.maxTempCelsius),
            dotClassName: tone.dot,
            swatchClassName: tone.swatch,
          },
        ]}
      />
    </HealthCard.Root>
  );
}

function MemoryByTypeCard({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const gt = useGT();
  const tone = HEALTH_TONES.memory;
  const { memory } = snapshot;
  const total = memory.totalBytes;
  const other = Math.max(0, total - memory.usedBytes - memory.availableBytes);
  const segments = [
    {
      label: gt("Used", { $context: "memory in use" }),
      bytes: memory.usedBytes,
      ring: "stroke-emerald-500",
      swatch: "bg-emerald-500",
    },
    {
      label: gt("Reserved", { $context: "memory neither used nor available" }),
      bytes: other,
      ring: "stroke-amber-400",
      swatch: "bg-amber-400",
    },
    {
      label: gt("Available"),
      bytes: memory.availableBytes,
      ring: "stroke-muted-foreground/25",
      swatch: "bg-muted-foreground/40",
    },
  ].filter((segment) => segment.bytes > 0);
  const percent = usedPercent(memory.usedBytes, total);
  return (
    <HealthCard.Root>
      <HealthCard.Header tone={tone} icon={MemoryStickIcon} title={gt("Memory by type")} />
      <div className="flex min-w-0 items-center gap-5">
        <Ring segments={segments} total={total}>
          <span className="text-lg font-semibold tabular-nums leading-none text-foreground">
            {percent === null ? "–" : `${Math.round(percent)}%`}
          </span>
          <span className="text-3xs text-muted-foreground">
            <T context="memory ring center label">in use</T>
          </span>
        </Ring>
        <dl className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-xs">
          {segments.map((segment) => (
            <div key={segment.label} className="contents">
              <dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span className={cn("size-2 shrink-0 rounded-full", segment.swatch)} />
                <span className="truncate">{segment.label}</span>
              </dt>
              <dd className="text-right font-semibold tabular-nums">
                {formatBytes(segment.bytes)}
              </dd>
            </div>
          ))}
          {memory.swapTotalBytes > 0 ? (
            <div className="contents">
              <dt className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span className="size-2 shrink-0 rounded-full border border-muted-foreground/50" />
                <span className="truncate">
                  <T>Swap</T>
                </span>
              </dt>
              <dd className="text-right font-semibold tabular-nums">
                {formatBytes(memory.swapUsedBytes)} / {formatBytes(memory.swapTotalBytes)}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </HealthCard.Root>
  );
}

const RING_RADIUS = 15.915; // circumference ≈ 100, so dash lengths are percentages

function Ring({
  segments,
  total,
  children,
}: {
  readonly segments: ReadonlyArray<{
    readonly label: string;
    readonly bytes: number;
    readonly ring: string;
  }>;
  readonly total: number;
  readonly children: ReactNode;
}) {
  const lengths = segments.map((segment) => (total > 0 ? (segment.bytes / total) * 100 : 0));
  return (
    <div className="relative grid size-28 shrink-0 place-items-center">
      <svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        {segments.map((segment, index) => {
          const length = lengths[index] ?? 0;
          const offset = lengths.slice(0, index).reduce((sum, value) => sum + value, 0);
          // Butt caps end where the segment does; the gap only separates neighbours.
          const dash = segments.length > 1 ? Math.max(0, length - 1) : length;
          return (
            <circle
              key={segment.label}
              cx={20}
              cy={20}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={4}
              className={segment.ring}
              strokeDasharray={`${dash} ${100 - dash}`}
              strokeDashoffset={-offset}
            />
          );
        })}
      </svg>
      <div className="relative flex flex-col items-center">{children}</div>
    </div>
  );
}

function StorageCard({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const gt = useGT();
  const tone = HEALTH_TONES.disk;
  const used = snapshot.disks.reduce((sum, disk) => sum + disk.usedBytes, 0);
  const total = snapshot.disks.reduce((sum, disk) => sum + disk.totalBytes, 0);
  return (
    <HealthCard.Root>
      <HealthCard.Header
        tone={tone}
        icon={HardDriveIcon}
        title={gt("Storage")}
        aside={
          total > 0
            ? gt("{used} of {total}", { used: formatBytes(used), total: formatBytes(total) })
            : undefined
        }
      />
      {snapshot.disks.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No disks reported.</T>
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {snapshot.disks.map((disk) => (
            <HealthCard.Meter
              key={disk.mountPoint}
              label={<span className="font-mono">{disk.mountPoint}</span>}
              percent={disk.usedPercent}
              value={formatPercent(disk.usedPercent)}
              fillClassName={usageFillClass(disk.usedPercent, "bg-orange-500")}
              trackClassName={tone.track}
            />
          ))}
        </div>
      )}
    </HealthCard.Root>
  );
}

function AboutCard({
  host,
  snapshot,
}: {
  readonly host: FleetHost;
  readonly snapshot: HostHealthSnapshot;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { metadata } = snapshot;
  const rows: ReadonlyArray<readonly [string, string, boolean]> = [
    [gt("Hostname"), metadata.hostname, true],
    [gt("System", { $context: "operating system" }), metadata.osVersion, false],
    [gt("Kernel"), `${metadata.kernel} (${metadata.arch})`, true],
    [gt("Processor"), metadata.cpuModel, false],
    [gt("Uptime"), formatUptime(metadata.uptimeSeconds, resolve), false],
    ...(host.viaLabel === null ? [] : [[gt("Read through"), host.viaLabel, false] as const]),
  ];
  return (
    <HealthCard.Root>
      <HealthCard.Header
        tone={HEALTH_TONES.neutral}
        icon={GaugeIcon}
        title={gt("About this machine")}
      />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        {rows.map(([label, value, mono]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              className={cn("truncate text-right font-semibold", mono && "font-mono font-medium")}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </HealthCard.Root>
  );
}

const DEFAULT_CRITICAL_CELSIUS = 100;

function SensorsCard({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const gt = useGT();
  const tone = HEALTH_TONES.temperature;
  const severity = new Map(snapshot.alerts.map((alert) => [alert.id, alert.severity]));
  return (
    <HealthCard.Root>
      <HealthCard.Header
        tone={tone}
        icon={ThermometerIcon}
        title={gt("Sensors")}
        aside={gt("{count, plural, one {{count} reading} other {{count} readings}}", {
          count: snapshot.sensors.length,
        })}
      />
      <div className="gap-x-8 md:columns-2 xl:columns-3">
        {sensorsByChip(snapshot.sensors).map(({ chip, sensors }) => (
          <div key={chip} className="mb-5 flex min-w-0 break-inside-avoid flex-col gap-2">
            <h3 className="truncate font-mono text-2xs font-medium text-muted-foreground">
              {chip}
            </h3>
            {sensors.map((sensor) => {
              const alert = severity.get(`temp:${sensor.id}`) ?? severity.get(`fan:${sensor.id}`);
              const alertText =
                alert === "critical"
                  ? "text-destructive-foreground"
                  : alert === "warning"
                    ? "text-warning-foreground"
                    : undefined;
              if (sensor.kind !== "temperature") {
                return (
                  <div
                    key={sensor.id}
                    className="flex min-w-0 items-baseline justify-between gap-3 text-xs"
                  >
                    <span className="truncate text-muted-foreground">{sensor.label}</span>
                    <span
                      className={cn(
                        "shrink-0 whitespace-nowrap font-semibold tabular-nums",
                        alertText ?? "text-foreground",
                      )}
                    >
                      {formatSensorValue(sensor)}
                    </span>
                  </div>
                );
              }
              const limit =
                sensor.criticalThreshold ?? sensor.highThreshold ?? DEFAULT_CRITICAL_CELSIUS;
              const percent = limit > 0 ? (sensor.value / limit) * 100 : null;
              return (
                <HealthCard.Meter
                  key={sensor.id}
                  label={sensor.label}
                  percent={percent}
                  value={<span className={alertText}>{formatSensorValue(sensor)}</span>}
                  fillClassName={
                    alert === "critical"
                      ? "bg-destructive"
                      : alert === "warning"
                        ? "bg-warning"
                        : tone.swatch
                  }
                  trackClassName={tone.track}
                />
              );
            })}
          </div>
        ))}
      </div>
    </HealthCard.Root>
  );
}

function CoolerControlCard({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const devices = snapshot.coolerControl?.devices ?? [];
  return (
    <HealthCard.Root>
      <HealthCard.Header tone={HEALTH_TONES.neutral} icon={GaugeIcon} title="CoolerControl" />
      <p className="text-xs text-muted-foreground">
        <T>
          CoolerControl runs on this machine and owns its fan and pump curves. iglo.code only reads
          the sensors.
        </T>
      </p>
      {devices.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5">
          {devices.map((device) => (
            <li key={device.id} className="rounded-md bg-muted px-2 py-0.5 text-2xs">
              {device.name}
              {device.type === "" ? null : (
                <span className="ml-1 text-muted-foreground">{device.type}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </HealthCard.Root>
  );
}
