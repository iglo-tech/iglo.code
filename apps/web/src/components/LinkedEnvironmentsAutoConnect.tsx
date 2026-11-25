import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  type LinkedAutoConnectPlan,
  planLinkedAutoConnect,
} from "@t3tools/client-runtime/linked-auto-connect";
import { connectLinkedEnvironment } from "@t3tools/client-runtime/linked-thread";
import { AuthAccessWriteScope, type EnvironmentId, type PeerLinkName } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { environmentCatalog } from "../connection/catalog";
import { linkedAutoConnectStore } from "../connection/linkedAutoConnectStore";
import { connectPairing, reachesEnvironment } from "../connection/onboarding";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { useEnvironments } from "../state/environments";
import { peerLinkEnvironment } from "../state/peerLinks";
import { useEnvironmentsWithScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

// Links made on another machine or in the CLI are not pushed to this device.
const LINKS_REFRESH_MS = 60_000;

const linkNamesAtom = environmentAtomList("linked-auto-connect:names", (environmentId) =>
  peerLinkEnvironment.names({ environmentId, input: {} }),
);

const inFlight = new Set<EnvironmentId>();

/**
 * Keeps this device connected to every machine its machines link to. A device is paired with one
 * machine; linking that machine to others is what brings them here, and forgetting the link takes
 * them away again. Machines paired by hand are never removed.
 */
export function LinkedEnvironmentsAutoConnect() {
  const { environments } = useEnvironments();
  const registry = useContext(RegistryContext);
  const { marks, waiting } = useSyncExternalStore(
    linkedAutoConnectStore.subscribe,
    linkedAutoConnectStore.getSnapshot,
  );
  const quiet = { reportFailure: false, reportDefect: false } as const;
  const requestPairing = useAtomCommand(peerLinkEnvironment.pairClient, quiet);
  const reaches = useAtomCommand(reachesEnvironment, quiet);
  const pair = useAtomCommand(connectPairing, quiet);
  const remove = useAtomCommand(environmentCatalog.remove, quiet);

  const offering = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      offersLinkedEnvironments(environment.serverConfig),
  );
  const offeringKey = environmentIdsKey(offering.map((environment) => environment.environmentId));
  const names = useAtomValue(linkNamesAtom(offeringKey));
  const mayPair = useEnvironmentsWithScope(offering, AuthAccessWriteScope);
  const linksById = new Map<EnvironmentId, ReadonlyArray<PeerLinkName> | null>(
    offering.map((environment, index) => {
      const result = names[index];
      return [
        environment.environmentId,
        result !== undefined && AsyncResult.isSuccess(result) ? result.value.links : null,
      ];
    }),
  );
  const plan = planLinkedAutoConnect({
    registered: environments.map((environment) => environment.environmentId),
    linking: environments.map((environment) => ({
      environmentId: environment.environmentId,
      links: linksById.has(environment.environmentId)
        ? (linksById.get(environment.environmentId) ?? null)
        : // One that offers no links links to nothing, and one switched off holds nothing back.
          environment.connection.phase === "connected" || !environment.entry.enabled
          ? []
          : null,
      mayPair: mayPair.has(environment.environmentId),
    })),
    marked: marks,
    waiting,
  });

  const apply = useEffectEvent(async (plan: LinkedAutoConnectPlan) => {
    if (plan.clearMarks.length > 0) linkedAutoConnectStore.setMarked(plan.clearMarks, false);
    for (const environmentId of plan.forget) {
      if (inFlight.has(environmentId)) continue;
      inFlight.add(environmentId);
      const result = await remove(environmentId).finally(() => inFlight.delete(environmentId));
      if (result._tag === "Success") linkedAutoConnectStore.setMarked([environmentId], false);
    }
    for (const target of plan.connect) {
      if (inFlight.has(target.environmentId)) continue;
      inFlight.add(target.environmentId);
      const outcome = await connectLinkedEnvironment({
        label: target.label,
        requestPairing: async () => {
          const result = await requestPairing({
            environmentId: target.via,
            input: { environmentId: target.environmentId },
          });
          return result._tag === "Success" ? result.value : null;
        },
        reaches: async (host) => {
          const result = await reaches({ host, environmentId: target.environmentId });
          return result._tag === "Success" && result.value;
        },
        pair: async ({ host, pairingCode }) => {
          const result = await pair({
            host,
            pairingCode,
            expectedEnvironmentId: target.environmentId,
          });
          return result._tag === "Success";
        },
      }).finally(() => inFlight.delete(target.environmentId));
      if (outcome.type === "connected") {
        linkedAutoConnectStore.setMarked([target.environmentId], true);
      } else {
        linkedAutoConnectStore.wait(target.environmentId);
      }
    }
  });

  const planKey = JSON.stringify(plan);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- joining and leaving linked machines is connection work outside React, started when the links say so
  useEffect(() => {
    void apply(JSON.parse(planKey) as LinkedAutoConnectPlan);
  }, [planKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- links made elsewhere are not pushed, so their names are read again on a timer
  useEffect(() => {
    if (offeringKey === "") return;
    const timer = window.setInterval(() => {
      for (const environmentId of offeringKey.split("\n") as EnvironmentId[]) {
        registry.refresh(peerLinkEnvironment.names({ environmentId, input: {} }));
      }
    }, LINKS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [registry, offeringKey]);

  return null;
}
