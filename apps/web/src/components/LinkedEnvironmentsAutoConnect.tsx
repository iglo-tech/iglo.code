import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  type LinkedAutoConnectPlan,
  type LinkingEnvironment,
  planLinkedAutoConnect,
} from "@t3tools/client-runtime/linked-auto-connect";
import { connectLinkedEnvironment } from "@t3tools/client-runtime/linked-thread";
import { AuthAccessWriteScope, type EnvironmentId, type PeerLinkName } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { environmentCatalog } from "../connection/catalog";
import { linkedAutoConnectStore } from "../connection/linkedAutoConnectStore";
import { connectPairing, reachesEnvironment } from "../connection/onboarding";
import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { type EnvironmentPresentation, useEnvironments } from "../state/environments";
import { peerLinkEnvironment } from "../state/peerLinks";
import { useEnvironmentsWithScope } from "../state/session";
import { expectsPrimaryEnvironment } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";

// Links made on another machine or in the CLI are not pushed to this device.
const LINKS_REFRESH_MS = 60_000;
const LOCK_NAME = "iglo.code:linked-auto-connect";

const linkNamesAtom = environmentAtomList("linked-auto-connect:names", (environmentId) =>
  peerLinkEnvironment.names({ environmentId, input: {} }),
);

const inFlight = new Set<EnvironmentId>();

/** One tab at a time joins or leaves machines, so two tabs never pair the same one twice. */
const exclusively = (work: () => Promise<void>): Promise<void> =>
  typeof navigator !== "undefined" && navigator.locks !== undefined
    ? navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) =>
        lock === null ? undefined : work(),
      )
    : work();

/** What `environment` links to, or null while that is unknown or its links are paused. */
function knownLinks(
  environment: EnvironmentPresentation,
  names: AsyncResult.AsyncResult<{ readonly links: ReadonlyArray<PeerLinkName> }, unknown> | null,
): ReadonlyArray<PeerLinkName> | null {
  const config = environment.serverConfig;
  if (environment.connection.phase !== "connected" || config === null) return null;
  // A server that cannot link links to nothing; one with its beta switched off is only paused.
  if (config.environment.capabilities.peerLinks !== true) return [];
  if (!offersLinkedEnvironments(config)) return null;
  return names !== null && AsyncResult.isSuccess(names) ? names.value.links : null;
}

/**
 * Keeps this device connected to every machine its machines link to. A device is paired with one
 * machine; linking that machine to others is what brings them here, and forgetting the link takes
 * them away again. Machines paired by hand are never removed.
 */
export function LinkedEnvironmentsAutoConnect() {
  const { environments, isReady } = useEnvironments();
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
  const namesById = new Map(
    offering.map((environment, index) => [environment.environmentId, names[index] ?? null]),
  );
  const mayPair = useEnvironmentsWithScope(offering, AuthAccessWriteScope);
  const isPrimary = (environment: EnvironmentPresentation) =>
    environment.entry.target._tag === "PrimaryConnectionTarget";
  // Until the catalog and this app's own machine are in, a missing machine is only not loaded yet.
  const loaded =
    isReady && (!expectsPrimaryEnvironment() || environments.some((env) => isPrimary(env)));
  const plan = loaded
    ? planLinkedAutoConnect({
        environments: environments.map((environment): LinkingEnvironment => ({
          environmentId: environment.environmentId,
          links: knownLinks(environment, namesById.get(environment.environmentId) ?? null),
          mayPair: mayPair.has(environment.environmentId),
          primary: isPrimary(environment),
        })),
        marked: marks,
        waiting,
      })
    : null;

  const reachableUrl = async (environmentId: EnvironmentId, urls: ReadonlyArray<string>) => {
    for (const host of urls) {
      const result = await reaches({ host, environmentId });
      if (result._tag === "Success" && result.value) return true;
    }
    return false;
  };

  const join = async (target: LinkedAutoConnectPlan["connect"][number]) => {
    // A code is minted only once this device is known to reach the machine, after a first try.
    const known = linkedAutoConnectStore.knownUrls(target.environmentId);
    if (known !== undefined && !(await reachableUrl(target.environmentId, known))) return false;
    const outcome = await connectLinkedEnvironment({
      label: target.label,
      requestPairing: async () => {
        const result = await requestPairing({
          environmentId: target.via,
          input: { environmentId: target.environmentId },
        });
        if (result._tag !== "Success") return null;
        linkedAutoConnectStore.rememberUrls(target.environmentId, result.value.urls);
        return result.value;
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
    });
    return outcome.type === "connected";
  };

  const apply = useEffectEvent((plan: LinkedAutoConnectPlan) =>
    exclusively(async () => {
      if (plan.clearWaits.length > 0) linkedAutoConnectStore.clearWaits(plan.clearWaits);
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
        const joined = await join(target).finally(() => inFlight.delete(target.environmentId));
        if (joined) {
          linkedAutoConnectStore.clearWaits([target.environmentId]);
          linkedAutoConnectStore.setMarked([target.environmentId], true);
        } else {
          linkedAutoConnectStore.wait(target.environmentId);
        }
      }
    }),
  );

  const planKey = plan === null ? null : JSON.stringify(plan);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- joining and leaving linked machines is connection work outside React, started when the links say so
  useEffect(() => {
    if (planKey !== null) void apply(JSON.parse(planKey) as LinkedAutoConnectPlan);
  }, [planKey]);

  useLiveRefresh(
    offeringKey === ""
      ? null
      : () => {
          for (const environmentId of offeringKey.split("\n") as EnvironmentId[]) {
            registry.refresh(peerLinkEnvironment.names({ environmentId, input: {} }));
          }
        },
    { key: "linked-auto-connect", intervalMs: LINKS_REFRESH_MS, refreshOnShow: true },
  );

  return null;
}
