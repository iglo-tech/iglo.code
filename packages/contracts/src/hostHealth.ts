import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const HostHealthRange = Schema.Literals(["1h", "24h", "7d", "30d"]);
export type HostHealthRange = typeof HostHealthRange.Type;

export const HostHealthMetadata = Schema.Struct({
  hostname: Schema.String,
  os: Schema.String,
  osVersion: Schema.String,
  kernel: Schema.String,
  arch: Schema.String,
  cpuModel: Schema.String,
  cpuCores: NonNegativeInt,
  uptimeSeconds: NonNegativeInt,
});
export type HostHealthMetadata = typeof HostHealthMetadata.Type;

export const HostCpuMetrics = Schema.Struct({
  utilizationPercent: Schema.NullOr(Schema.Number),
  load1m: Schema.Number,
  load5m: Schema.Number,
  load15m: Schema.Number,
});
export type HostCpuMetrics = typeof HostCpuMetrics.Type;

export const HostMemoryMetrics = Schema.Struct({
  totalBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  swapTotalBytes: NonNegativeInt,
  swapUsedBytes: NonNegativeInt,
  zramTotalBytes: Schema.optionalKey(NonNegativeInt),
  zramUsedBytes: Schema.optionalKey(NonNegativeInt),
});
export type HostMemoryMetrics = typeof HostMemoryMetrics.Type;

export const HostDiskMount = Schema.Struct({
  mountPoint: Schema.String,
  filesystem: Schema.String,
  totalBytes: NonNegativeInt,
  usedBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  usedPercent: Schema.Number,
});
export type HostDiskMount = typeof HostDiskMount.Type;

export const HostDiskIoMetrics = Schema.Struct({
  readBytesPerSec: Schema.NullOr(Schema.Number),
  writeBytesPerSec: Schema.NullOr(Schema.Number),
});
export type HostDiskIoMetrics = typeof HostDiskIoMetrics.Type;

export const HostNetworkMetrics = Schema.Struct({
  rxBytesPerSec: Schema.NullOr(Schema.Number),
  txBytesPerSec: Schema.NullOr(Schema.Number),
});
export type HostNetworkMetrics = typeof HostNetworkMetrics.Type;

export const HostSensorKind = Schema.Literals(["temperature", "fan", "pwm"]);
export type HostSensorKind = typeof HostSensorKind.Type;

export const HostSensorUnit = Schema.Literals(["celsius", "rpm", "percent"]);
export type HostSensorUnit = typeof HostSensorUnit.Type;

export const HostSensorReading = Schema.Struct({
  id: TrimmedNonEmptyString,
  chip: Schema.String,
  kind: HostSensorKind,
  label: Schema.String,
  value: Schema.Number,
  unit: HostSensorUnit,
  highThreshold: Schema.optionalKey(Schema.Number),
  criticalThreshold: Schema.optionalKey(Schema.Number),
});
export type HostSensorReading = typeof HostSensorReading.Type;

export const HostHealthAlertSeverity = Schema.Literals(["warning", "critical"]);
export type HostHealthAlertSeverity = typeof HostHealthAlertSeverity.Type;

/** What tripped: clients write the sentence, so it reads in the viewer's language. */
export const HostHealthAlertKind = Schema.Literals(["memory", "disk", "temperature", "fan"]);
export type HostHealthAlertKind = typeof HostHealthAlertKind.Type;

export const HostHealthAlert = Schema.Struct({
  id: TrimmedNonEmptyString,
  severity: HostHealthAlertSeverity,
  kind: HostHealthAlertKind,
  /** The mount point or sensor name; empty for memory. */
  subject: Schema.String,
  /** Percent used for memory and disk, °C for temperature, RPM for fans. */
  value: Schema.Number,
  threshold: Schema.optionalKey(Schema.Number),
});
export type HostHealthAlert = typeof HostHealthAlert.Type;

export const CoolerControlDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** CoolerControl's device type, such as Hwmon, Liquidctl, GPU or CPU. */
  type: Schema.String,
});
export type CoolerControlDevice = typeof CoolerControlDevice.Type;

/** A local coolercontrold that answered, read only; present only when one did. */
export const CoolerControlStatus = Schema.Struct({
  devices: Schema.Array(CoolerControlDevice),
});
export type CoolerControlStatus = typeof CoolerControlStatus.Type;

export const HostHealthSnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  metadata: HostHealthMetadata,
  cpu: HostCpuMetrics,
  memory: HostMemoryMetrics,
  disks: Schema.Array(HostDiskMount),
  diskIo: HostDiskIoMetrics,
  network: HostNetworkMetrics,
  sensors: Schema.Array(HostSensorReading),
  alerts: Schema.Array(HostHealthAlert),
  coolerControl: Schema.optionalKey(CoolerControlStatus),
});
export type HostHealthSnapshot = typeof HostHealthSnapshot.Type;

export const HostHealthHistoryPoint = Schema.Struct({
  timestamp: NonNegativeInt,
  cpuPercent: Schema.NullOr(Schema.Number),
  load1m: Schema.Number,
  memoryUsedBytes: NonNegativeInt,
  memoryTotalBytes: NonNegativeInt,
  swapUsedBytes: NonNegativeInt,
  diskReadBytesPerSec: Schema.NullOr(Schema.Number),
  diskWriteBytesPerSec: Schema.NullOr(Schema.Number),
  netRxBytesPerSec: Schema.NullOr(Schema.Number),
  netTxBytesPerSec: Schema.NullOr(Schema.Number),
  maxTempCelsius: Schema.NullOr(Schema.Number),
});
export type HostHealthHistoryPoint = typeof HostHealthHistoryPoint.Type;

export const HostHealthHistoryInput = Schema.Struct({
  range: HostHealthRange,
});
export type HostHealthHistoryInput = typeof HostHealthHistoryInput.Type;

export const HostHealthHistory = Schema.Struct({
  range: HostHealthRange,
  resolutionSeconds: PositiveInt,
  points: Schema.Array(HostHealthHistoryPoint),
});
export type HostHealthHistory = typeof HostHealthHistory.Type;

export const PeerLinkHostHealthInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type PeerLinkHostHealthInput = typeof PeerLinkHostHealthInput.Type;

export const PeerLinkHostHealthHistoryInput = Schema.Struct({
  environmentId: EnvironmentId,
  range: HostHealthRange,
});
export type PeerLinkHostHealthHistoryInput = typeof PeerLinkHostHealthHistoryInput.Type;

export class PeerLinkHostHealthReadError extends Schema.TaggedError<PeerLinkHostHealthReadError>()(
  "PeerLinkHostHealthReadError",
  {
    reason: Schema.Literals([
      "disabled",
      "unknown_link",
      "expired",
      "rejected",
      "unreachable",
      "incompatible",
    ]),
    label: Schema.NullOr(Schema.String),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
