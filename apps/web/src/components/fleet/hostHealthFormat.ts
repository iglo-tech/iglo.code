import type {
  HostHealthAlert,
  HostHealthRange,
  HostHealthSnapshot,
  HostSensorReading,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { formatBytes } from "../../lib/formatBytes";

export const HOST_HEALTH_RANGES: ReadonlyArray<HostHealthRange> = ["1h", "24h", "7d", "30d"];

export const HOST_HEALTH_RANGE_MS: Record<HostHealthRange, number> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

export function isHostHealthRange(value: unknown): value is HostHealthRange {
  return typeof value === "string" && (HOST_HEALTH_RANGES as ReadonlyArray<string>).includes(value);
}

export type HostHealthStatus = "ok" | "warning" | "critical";

export function hostHealthStatus(snapshot: HostHealthSnapshot): HostHealthStatus {
  if (snapshot.alerts.some((alert) => alert.severity === "critical")) return "critical";
  return snapshot.alerts.length > 0 ? "warning" : "ok";
}

export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "–" : `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "–" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function usedPercent(used: number, total: number): number | null {
  return total > 0 ? Math.min(100, (used / total) * 100) : null;
}

export function formatUptime(seconds: number, resolve: MessageResolver = m): string {
  return formatDuration(seconds * 1_000, resolve);
}

export function formatSensorValue(sensor: HostSensorReading): string {
  switch (sensor.unit) {
    case "celsius":
      return `${sensor.value.toFixed(1)} °C`;
    case "rpm":
      return `${Math.round(sensor.value)} RPM`;
    case "percent":
      return `${Math.round(sensor.value)}%`;
  }
}

/** The hottest temperature sensor, which the overview shows for the whole machine. */
export function hottestSensor(sensors: ReadonlyArray<HostSensorReading>): HostSensorReading | null {
  let hottest: HostSensorReading | null = null;
  for (const sensor of sensors) {
    if (sensor.kind !== "temperature") continue;
    if (hottest === null || sensor.value > hottest.value) hottest = sensor;
  }
  return hottest;
}

/**
 * Sensors by the device that reports them, in the order the server listed them. Two devices
 * with one driver (two NVMe drives) share a chip name, so repeats are numbered.
 */
export function sensorsByChip(
  sensors: ReadonlyArray<HostSensorReading>,
): ReadonlyArray<{ readonly chip: string; readonly sensors: ReadonlyArray<HostSensorReading> }> {
  const groups = new Map<string, { chip: string; sensors: HostSensorReading[] }>();
  for (const sensor of sensors) {
    // Ids start with the device ("hwmon3:temp1"), so one device keeps its readings together.
    const colon = sensor.id.indexOf(":");
    const key = `${colon < 0 ? "" : sensor.id.slice(0, colon)}\u0000${sensor.chip}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { chip: sensor.chip, sensors: [sensor] });
    else group.sensors.push(sensor);
  }
  const list = [...groups.values()];
  const counts = new Map<string, number>();
  for (const group of list) counts.set(group.chip, (counts.get(group.chip) ?? 0) + 1);
  const seen = new Map<string, number>();
  return list.map((group) => {
    if ((counts.get(group.chip) ?? 0) < 2) return group;
    const index = (seen.get(group.chip) ?? 0) + 1;
    seen.set(group.chip, index);
    return { chip: `${group.chip} ${index}`, sensors: group.sensors };
  });
}

export function hostHealthAlertText(alert: HostHealthAlert, resolve: MessageResolver = m): string {
  const value = alert.value.toFixed(alert.kind === "temperature" ? 1 : 0);
  switch (alert.kind) {
    case "memory":
      return resolve(msg("Memory is {value}% used", { value }));
    case "disk":
      return resolve(msg("{mount} is {value}% full", { mount: alert.subject, value }));
    case "temperature":
      return resolve(msg("{sensor} is at {value} °C", { sensor: alert.subject, value }));
    case "fan":
      return resolve(msg("{sensor} stopped (0 RPM)", { sensor: alert.subject }));
  }
}
