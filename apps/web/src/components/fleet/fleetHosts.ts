import type { EnvironmentId } from "@t3tools/contracts";

/**
 * - `live`: health can be read now.
 * - `offline`: the client is not connected to it.
 * - `unsupported`: its server predates host health.
 * - `forbidden`: this connection may not read its diagnostics.
 */
export type FleetHostAvailability = "live" | "offline" | "unsupported" | "forbidden";

export interface FleetHost {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The connected environment a linked machine is read through; null when read directly. */
  readonly viaEnvironmentId: EnvironmentId | null;
  readonly viaLabel: string | null;
  readonly availability: FleetHostAvailability;
}

export interface FleetDirectEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly supportsHostHealth: boolean;
  readonly canReadDiagnostics: boolean;
}

/** A connected environment that can read the machines it links to. */
export interface FleetLinkSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly links: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}

function directAvailability(environment: FleetDirectEnvironment): FleetHostAvailability {
  if (!environment.connected) return "offline";
  if (!environment.supportsHostHealth) return "unsupported";
  return environment.canReadDiagnostics ? "live" : "forbidden";
}

/**
 * Every machine the client can see: its own connections, then machines only reachable through a
 * link. A machine reached both ways is read directly while that connection works, and through
 * the first link that reaches it otherwise.
 */
export function fleetHosts(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly direct: ReadonlyArray<FleetDirectEnvironment>;
  readonly linkSources: ReadonlyArray<FleetLinkSource>;
}): ReadonlyArray<FleetHost> {
  const hosts = new Map<EnvironmentId, FleetHost>();
  for (const environment of input.direct) {
    hosts.set(environment.environmentId, {
      environmentId: environment.environmentId,
      label: environment.label,
      viaEnvironmentId: null,
      viaLabel: null,
      availability: directAvailability(environment),
    });
  }
  for (const source of input.linkSources) {
    for (const link of source.links) {
      if (link.environmentId === source.environmentId) continue;
      const existing = hosts.get(link.environmentId);
      if (existing !== undefined && (existing.availability === "live" || existing.viaLabel)) {
        continue;
      }
      hosts.set(link.environmentId, {
        environmentId: link.environmentId,
        label: existing?.label ?? link.label,
        viaEnvironmentId: source.environmentId,
        viaLabel: source.label,
        availability: "live",
      });
    }
  }
  const rank = (host: FleetHost) =>
    host.environmentId === input.primaryEnvironmentId ? 0 : host.availability === "live" ? 1 : 2;
  return [...hosts.values()].sort(
    (left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label),
  );
}
