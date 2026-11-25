import type { HostHealthHistory, HostHealthRange, HostHealthSnapshot } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { AlertTriangleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import type { FleetHost } from "./fleetHosts";
import { HostHealthChart } from "./HostHealthChart";
import { HostUsageBar } from "./HostUsageBar";
import {
  formatPercent,
  formatRate,
  formatSensorValue,
  formatUptime,
  HOST_HEALTH_RANGE_MS,
  hostHealthAlertText,
  sensorsByChip,
  usedPercent,
} from "./hostHealthFormat";
import { useHostHealthHistory, useHostHealthSnapshot } from "./useHostHealth";

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
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <HostSummary host={host} snapshot={snapshot} />
      {snapshot.alerts.length === 0 ? null : <HostAlerts snapshot={snapshot} />}
      <HostCharts history={history.data} error={history.error} snapshot={snapshot} />
      <HostDisks snapshot={snapshot} />
      {snapshot.sensors.length === 0 ? null : <HostSensors snapshot={snapshot} />}
      {snapshot.coolerControl === undefined ? null : <HostCoolerControl snapshot={snapshot} />}
    </div>
  );
}

function Panel({
  title,
  children,
  className,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border/60 bg-card p-4", className)}>
      <h2 className="mb-3 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function HostSummary({
  host,
  snapshot,
}: {
  readonly host: FleetHost;
  readonly snapshot: HostHealthSnapshot;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { metadata, memory, cpu } = snapshot;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Panel title={gt("Host")}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">
            <T>Hostname</T>
          </dt>
          <dd className="truncate font-mono">{metadata.hostname}</dd>
          <dt className="text-muted-foreground">
            <T context="operating system">System</T>
          </dt>
          <dd className="truncate">{metadata.osVersion}</dd>
          <dt className="text-muted-foreground">
            <T>Kernel</T>
          </dt>
          <dd className="truncate font-mono">
            {metadata.kernel} ({metadata.arch})
          </dd>
          <dt className="text-muted-foreground">
            <T>Processor</T>
          </dt>
          <dd className="truncate">
            {gt("{model} · {count, plural, one {{count} core} other {{count} cores}}", {
              model: metadata.cpuModel,
              count: metadata.cpuCores,
            })}
          </dd>
          <dt className="text-muted-foreground">
            <T>Uptime</T>
          </dt>
          <dd className="tabular-nums">{formatUptime(metadata.uptimeSeconds, resolve)}</dd>
          {host.viaLabel === null ? null : (
            <>
              <dt className="text-muted-foreground">
                <T>Read through</T>
              </dt>
              <dd className="truncate">{host.viaLabel}</dd>
            </>
          )}
        </dl>
      </Panel>
      <Panel title={gt("Now", { $context: "current host health values" })}>
        <div className="grid gap-3 sm:grid-cols-2">
          <HostUsageBar label={gt("CPU")} percent={cpu.utilizationPercent} />
          <div className="flex items-baseline justify-between gap-2 text-2xs">
            <span className="text-muted-foreground">
              <T context="system load average">Load</T>
            </span>
            <span className="tabular-nums text-foreground">
              {cpu.load1m.toFixed(2)} · {cpu.load5m.toFixed(2)} · {cpu.load15m.toFixed(2)}
            </span>
          </div>
          <HostUsageBar
            label={gt("Memory")}
            percent={usedPercent(memory.usedBytes, memory.totalBytes)}
            detail={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
          />
          {memory.swapTotalBytes > 0 ? (
            <HostUsageBar
              label={gt("Swap")}
              percent={usedPercent(memory.swapUsedBytes, memory.swapTotalBytes)}
              detail={`${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}`}
            />
          ) : null}
          {memory.zramTotalBytes === undefined || memory.zramUsedBytes === undefined ? null : (
            <div className="flex items-baseline justify-between gap-2 text-2xs">
              <span className="text-muted-foreground">zram</span>
              <span className="tabular-nums text-foreground">
                {formatBytes(memory.zramUsedBytes)} / {formatBytes(memory.zramTotalBytes)}
              </span>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-2 text-2xs">
            <span className="text-muted-foreground">
              <T>Network</T>
            </span>
            <span className="tabular-nums text-foreground">
              ↓ {formatRate(snapshot.network.rxBytesPerSec)} ↑{" "}
              {formatRate(snapshot.network.txBytesPerSec)}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 text-2xs">
            <span className="text-muted-foreground">
              <T>Disk I/O</T>
            </span>
            <span className="tabular-nums text-foreground">
              {gt("read {read}, write {write}", {
                read: formatRate(snapshot.diskIo.readBytesPerSec),
                write: formatRate(snapshot.diskIo.writeBytesPerSec),
              })}
            </span>
          </div>
        </div>
      </Panel>
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
            "flex items-center gap-2 rounded-md px-3 py-2 text-xs",
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

function HostCharts({
  history,
  error,
  snapshot,
}: {
  readonly history: HostHealthHistory | null;
  readonly error: string | null;
  readonly snapshot: HostHealthSnapshot;
}) {
  const gt = useGT();
  if (history === null) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {error ?? <T>Loading history…</T>}
      </p>
    );
  }
  const points = history.points;
  const timestamps = points.map((point) => point.timestamp);
  const lastAt = timestamps.length > 0 ? timestamps[timestamps.length - 1] : undefined;
  const toMs = Math.max(snapshot.sampledAt, lastAt ?? 0);
  const fromMs = toMs - HOST_HEALTH_RANGE_MS[history.range];
  // A missed sample or two is noise; a longer silence means the server was down.
  const maxGapMs = history.resolutionSeconds * 1_000 * 3;
  const common = { timestamps, fromMs, toMs, maxGapMs };
  const hasTemperature = points.some((point) => point.maxTempCelsius !== null);
  const memoryTotal = Math.max(0, ...points.map((point) => point.memoryTotalBytes));
  if (points.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <T>No history yet. Samples are taken every 10 seconds while the server runs.</T>
      </p>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <HostHealthChart
        {...common}
        title={gt("CPU usage")}
        fixedMax={100}
        formatValue={(value) => formatPercent(value)}
        series={[
          {
            label: gt("CPU"),
            values: points.map((point) => point.cpuPercent),
            strokeClassName: "stroke-foreground/70",
            swatchClassName: "bg-foreground/70",
          },
        ]}
      />
      <HostHealthChart
        {...common}
        title={gt("Load average (1 min)")}
        formatValue={(value) => value.toFixed(2)}
        series={[
          {
            label: gt("Load", { $context: "system load average" }),
            values: points.map((point) => point.load1m),
            strokeClassName: "stroke-info",
            swatchClassName: "bg-info",
          },
        ]}
      />
      <HostHealthChart
        {...common}
        title={gt("Memory")}
        {...(memoryTotal > 0 ? { fixedMax: memoryTotal } : {})}
        formatValue={formatBytes}
        series={[
          {
            label: gt("Used", { $context: "memory in use" }),
            values: points.map((point) => point.memoryUsedBytes),
            strokeClassName: "stroke-foreground/70",
            swatchClassName: "bg-foreground/70",
          },
          {
            label: gt("Swap"),
            values: points.map((point) => point.swapUsedBytes),
            strokeClassName: "stroke-warning",
            swatchClassName: "bg-warning",
          },
        ]}
      />
      <HostHealthChart
        {...common}
        title={gt("Network")}
        formatValue={formatRate}
        series={[
          {
            label: gt("In", { $context: "network traffic received" }),
            values: points.map((point) => point.netRxBytesPerSec),
            strokeClassName: "stroke-info",
            swatchClassName: "bg-info",
          },
          {
            label: gt("Out", { $context: "network traffic sent" }),
            values: points.map((point) => point.netTxBytesPerSec),
            strokeClassName: "stroke-success",
            swatchClassName: "bg-success",
          },
        ]}
      />
      <HostHealthChart
        {...common}
        title={gt("Disk I/O")}
        formatValue={formatRate}
        series={[
          {
            label: gt("Read", { $context: "disk bytes read" }),
            values: points.map((point) => point.diskReadBytesPerSec),
            strokeClassName: "stroke-info",
            swatchClassName: "bg-info",
          },
          {
            label: gt("Write", { $context: "disk bytes written" }),
            values: points.map((point) => point.diskWriteBytesPerSec),
            strokeClassName: "stroke-warning",
            swatchClassName: "bg-warning",
          },
        ]}
      />
      {hasTemperature ? (
        <HostHealthChart
          {...common}
          title={gt("Hottest sensor")}
          formatValue={(value) => `${value.toFixed(0)} °C`}
          series={[
            {
              label: gt("Peak", { $context: "highest temperature" }),
              values: points.map((point) => point.maxTempCelsius),
              strokeClassName: "stroke-destructive",
              swatchClassName: "bg-destructive",
            },
          ]}
        />
      ) : null}
    </div>
  );
}

function HostDisks({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const gt = useGT();
  if (snapshot.disks.length === 0) return null;
  return (
    <Panel title={gt("Disks")}>
      <div className="grid gap-3 sm:grid-cols-2">
        {snapshot.disks.map((disk) => (
          <HostUsageBar
            key={disk.mountPoint}
            label={`${disk.mountPoint} · ${disk.filesystem}`}
            percent={disk.usedPercent}
            detail={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`}
          />
        ))}
      </div>
    </Panel>
  );
}

function HostSensors({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const gt = useGT();
  const alerting = new Set(snapshot.alerts.map((alert) => alert.id));
  return (
    <Panel title={gt("Sensors")}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {sensorsByChip(snapshot.sensors).map(({ chip, sensors }) => (
          <div key={chip} className="min-w-0">
            <h3 className="mb-1.5 truncate font-mono text-2xs text-muted-foreground">{chip}</h3>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
              {sensors.map((sensor) => {
                const hot = alerting.has(`temp:${sensor.id}`) || alerting.has(`fan:${sensor.id}`);
                return (
                  <div key={sensor.id} className="contents">
                    <dt className="truncate text-muted-foreground">{sensor.label}</dt>
                    <dd
                      className={cn(
                        "text-right tabular-nums",
                        hot ? "text-destructive-foreground" : "text-foreground",
                      )}
                    >
                      {formatSensorValue(sensor)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function HostCoolerControl({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const devices = snapshot.coolerControl?.devices ?? [];
  return (
    <Panel title="CoolerControl">
      <p className="mb-2 text-xs text-muted-foreground">
        <T>
          CoolerControl runs on this machine and owns its fan and pump curves. iglo.code only reads
          the sensors.
        </T>
      </p>
      {devices.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5">
          {devices.map((device) => (
            <li key={device.id} className="rounded-md border border-border/60 px-2 py-0.5 text-2xs">
              {device.name}
              {device.type === "" ? null : (
                <span className="ml-1 text-muted-foreground">{device.type}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
