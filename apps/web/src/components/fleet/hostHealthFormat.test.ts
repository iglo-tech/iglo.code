import type { HostHealthAlert, HostSensorReading } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatRate,
  formatSensorValue,
  hostHealthAlertText,
  hottestSensor,
  isHostHealthRange,
  sensorsByChip,
} from "./hostHealthFormat";

const sensor = (
  id: string,
  chip: string,
  kind: HostSensorReading["kind"],
  value: number,
): HostSensorReading => ({
  id,
  chip,
  kind,
  label: id,
  value,
  unit: kind === "temperature" ? "celsius" : kind === "fan" ? "rpm" : "percent",
});

describe("host health formatting", () => {
  it("accepts only the ranges the server keeps", () => {
    expect(["1h", "24h", "7d", "30d", "90d", 1].map(isHostHealthRange)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("writes rates and sensor values in their units", () => {
    expect(formatRate(null)).toBe("–");
    expect(formatRate(2_048)).toBe("2.00 KB/s");
    expect(formatSensorValue(sensor("t", "k10temp", "temperature", 61.25))).toBe("61.3 °C");
    expect(formatSensorValue(sensor("f", "nct6799", "fan", 1210.4))).toBe("1210 RPM");
    expect(formatSensorValue(sensor("p", "nct6799", "pwm", 50.2))).toBe("50%");
  });

  it("groups sensors by chip and finds the hottest", () => {
    const sensors = [
      sensor("a", "k10temp", "temperature", 55),
      sensor("b", "nvme", "temperature", 61),
      sensor("c", "k10temp", "fan", 9000),
    ];
    expect(sensorsByChip(sensors).map((group) => [group.chip, group.sensors.length])).toEqual([
      ["k10temp", 2],
      ["nvme", 1],
    ]);
    expect(hottestSensor(sensors)?.id).toBe("b");
    expect(hottestSensor([sensor("c", "x", "fan", 100)])).toBeNull();
  });

  it("describes each alert in a sentence", () => {
    const alert = (kind: HostHealthAlert["kind"], subject: string, value: number) =>
      hostHealthAlertText({ id: kind, severity: "warning", kind, subject, value });
    expect([
      alert("memory", "", 92.4),
      alert("disk", "/mnt/data", 88),
      alert("temperature", "k10temp Tctl", 91.25),
      alert("fan", "nct6799 Pump", 0),
    ]).toEqual([
      "Memory is 92% used",
      "/mnt/data is 88% full",
      "k10temp Tctl is at 91.3 °C",
      "nct6799 Pump stopped (0 RPM)",
    ]);
  });
});
