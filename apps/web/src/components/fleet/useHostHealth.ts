import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  AuthDiagnosticsReadScope,
  type HostHealthHistory,
  type HostHealthRange,
  type HostHealthSnapshot,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { type EnvironmentQueryView, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { type FleetHost, fleetHosts } from "./fleetHosts";

// Names only: listing links would probe every linked machine on each read.
const linkNamesAtom = environmentAtomList("fleet:link-names", (environmentId) =>
  peerLinkEnvironment.names({ environmentId, input: {} }),
);

/** Whether any connected environment serves host health, which is when Fleet is worth opening. */
export function useFleetAvailable(): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.hostHealth === true,
  );
}

export function useFleetHosts(): ReadonlyArray<FleetHost> {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const readable = useEnvironmentsWithScope(environments, AuthDiagnosticsReadScope);
  const direct = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    connected: environment.connection.phase === "connected",
    supportsHostHealth: environment.serverConfig?.environment.capabilities.hostHealth === true,
    canReadDiagnostics: readable.has(environment.environmentId),
  }));
  const sources = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.hostHealth === true &&
      offersLinkedEnvironments(environment.serverConfig) &&
      readable.has(environment.environmentId),
  );
  const names = useAtomValue(
    linkNamesAtom(environmentIdsKey(sources.map((source) => source.environmentId))),
  );
  return fleetHosts({
    primaryEnvironmentId,
    direct,
    linkSources: sources.map((source, index) => {
      const listed = names[index];
      return {
        environmentId: source.environmentId,
        label: source.label,
        links: listed?._tag === "Success" ? listed.value.links : [],
      };
    }),
  });
}

/** The host's latest sample: streamed from a direct connection, re-read through a link. */
export function useHostHealthSnapshot(
  host: FleetHost | null,
): EnvironmentQueryView<HostHealthSnapshot> {
  const resolve = useMessages();
  const live = host !== null && host.availability === "live";
  const direct = useEnvironmentQuery(
    live && host.viaEnvironmentId === null
      ? serverEnvironment.hostHealthLive({ environmentId: host.environmentId, input: {} })
      : null,
    resolve,
  );
  const linked = useEnvironmentQuery(
    live && host.viaEnvironmentId !== null
      ? peerLinkEnvironment.hostHealth({
          environmentId: host.viaEnvironmentId,
          input: { environmentId: host.environmentId },
        })
      : null,
    resolve,
  );
  return host?.viaEnvironmentId === null ? direct : linked;
}

export function useHostHealthHistory(
  host: FleetHost | null,
  range: HostHealthRange,
): EnvironmentQueryView<HostHealthHistory> {
  const resolve = useMessages();
  const live = host !== null && host.availability === "live";
  const direct = useEnvironmentQuery(
    live && host.viaEnvironmentId === null
      ? serverEnvironment.hostHealthHistory({
          environmentId: host.environmentId,
          input: { range },
        })
      : null,
    resolve,
  );
  const linked = useEnvironmentQuery(
    live && host.viaEnvironmentId !== null
      ? peerLinkEnvironment.hostHealthHistory({
          environmentId: host.viaEnvironmentId,
          input: { environmentId: host.environmentId, range },
        })
      : null,
    resolve,
  );
  return host?.viaEnvironmentId === null ? direct : linked;
}
