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
import { useContext, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

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
const LEADER_LOCK = "iglo.code:linked-auto-connect";

const linkNamesAtom = environmentAtomList("linked-auto-connect:names", (environmentId) =>
  peerLinkEnvironment.names({ environmentId, input: {} }),
);

const inFlight = new Set<EnvironmentId>();
// A machine refusing every fresh session must not loop through removing and pairing it.
const REJOIN_EVERY_MS = 10 * 60_000;
const rejoinedAt = new Map<EnvironmentId, number>();
const mayRejoin = (environmentId: EnvironmentId) => {
  const now = Date.now();
  if (now - (rejoinedAt.get(environmentId) ?? 0) < REJOIN_EVERY_MS) return false;
  rejoinedAt.set(environmentId, now);
  return true;
};

type LinkNames = AsyncResult.AsyncResult<{ readonly links: ReadonlyArray<PeerLinkName> }, unknown>;

/** What `environment` links to now, when it says. */
function liveLinks(
  environment: EnvironmentPresentation,
  names: LinkNames | null,
): ReadonlyArray<PeerLinkName> | null {
  const config = environment.serverConfig;
  if (environment.connection.phase !== "connected" || config === null) return null;
  if (config.environment.capabilities.peerLinks !== true) return [];
  return offersLinkedEnvironments(config) && names !== null && AsyncResult.isSuccess(names)
    ? names.value.links
    : null;
}

/**
 * What the planner goes by: links now, else the last known. With neither, a machine that answers
 * but has its links paused, or cannot list them, links to nothing; one not answered yet is unknown.
 */
function plannedLinks(
  environment: EnvironmentPresentation,
  names: LinkNames | null,
  last: ReadonlyArray<PeerLinkName> | undefined,
): ReadonlyArray<PeerLinkName> | null {
  const live = liveLinks(environment, names);
  if (live !== null) return live;
  if (last !== undefined) return last;
  const config = environment.serverConfig;
  if (environment.connection.phase !== "connected" || config === null) return null;
  if (!offersLinkedEnvironments(config)) return [];
  return names !== null && AsyncResult.isFailure(names) && !names.waiting ? [] : null;
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Keeps this device connected to every machine its machines link to. A device is paired with one
 * machine; linking that machine to others is what brings them here, and forgetting the link takes
 * them away again. Machines paired by hand are never removed. The tab in use acts for the device
 * (a Web Lock held while it is visible), so two tabs never pair the same machine.
 */
export function LinkedEnvironmentsAutoConnect() {
  const [leader, setLeader] = useState(
    () => typeof navigator === "undefined" || navigator.locks === undefined,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a Web Lock while this tab is visible, so the tab in use acts for the device
  useEffect(() => {
    if (typeof navigator === "undefined" || navigator.locks === undefined) return;
    let abort: AbortController | null = null;
    let release: (() => void) | null = null;
    const stop = () => {
      abort?.abort();
      abort = null;
      release?.();
      release = null;
      setLeader(false);
    };
    const start = () => {
      if (abort !== null) return;
      const controller = new AbortController();
      abort = controller;
      navigator.locks
        .request(
          LEADER_LOCK,
          { signal: controller.signal },
          () =>
            new Promise<void>((resolve) => {
              // Granted just as the tab hid: let the lock go to the tab now in use.
              if (abort !== controller) return resolve();
              release = resolve;
              setLeader(true);
            }),
        )
        .catch(() => undefined);
    };
    const sync = () => (visible() ? start() : stop());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stop();
    };
  }, []);
  return leader ? <LinkedEnvironmentsAutoConnectLeader /> : null;
}

function LinkedEnvironmentsAutoConnectLeader() {
  const { environments, isReady } = useEnvironments();
  const registry = useContext(RegistryContext);
  const stored = useSyncExternalStore(
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
  const live = new Map(
    environments.flatMap((environment) => {
      const links = liveLinks(environment, namesById.get(environment.environmentId) ?? null);
      return links === null ? [] : [[environment.environmentId, links] as const];
    }),
  );
  // Until the catalog and this app's own machine are in, a missing machine is only not loaded yet.
  const loaded =
    isReady && (!expectsPrimaryEnvironment() || environments.some((env) => isPrimary(env)));
  const plan = loaded
    ? planLinkedAutoConnect({
        environments: environments.map((environment): LinkingEnvironment => ({
          environmentId: environment.environmentId,
          links: plannedLinks(
            environment,
            namesById.get(environment.environmentId) ?? null,
            stored.links.get(environment.environmentId),
          ),
          mayPair: mayPair.has(environment.environmentId),
          primary: isPrimary(environment),
          refused: environment.connection.credentialRefused === true,
        })),
        joined: stored.joined,
        dismissed: stored.dismissed,
        waiting: stored.waiting,
      })
    : null;

  const reachesAny = async (environmentId: EnvironmentId, urls: ReadonlyArray<string>) => {
    for (const host of urls) {
      const result = await reaches({ host, environmentId });
      if (result._tag === "Success" && result.value) return true;
    }
    return false;
  };

  const join = async (target: LinkedAutoConnectPlan["connect"][number]) => {
    // A code is minted only once this device is known to reach the machine, after a first try.
    const known = linkedAutoConnectStore.knownUrls(target.environmentId);
    if (known !== undefined && !(await reachesAny(target.environmentId, known))) {
      // The link may have learned an address since (a Serve name, a rename): ask again next try.
      linkedAutoConnectStore.forgetUrls(target.environmentId);
      return false;
    }
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
          viaLink: true,
        });
        return result._tag === "Success";
      },
    });
    return outcome.type === "connected";
  };

  const removeOnce = async (environmentId: EnvironmentId, then: () => void) => {
    if (inFlight.has(environmentId)) return;
    inFlight.add(environmentId);
    const result = await remove(environmentId).finally(() => inFlight.delete(environmentId));
    if (result._tag === "Success") then();
  };

  const apply = useEffectEvent(async (plan: LinkedAutoConnectPlan) => {
    linkedAutoConnectStore.rememberLinks(live);
    linkedAutoConnectStore.clearWaits(plan.clearWaits);
    linkedAutoConnectStore.clear({ joined: plan.clearJoined, dismissed: plan.clearDismissed });
    for (const environmentId of plan.forget) {
      // It may have been paired by hand since this plan was made.
      if (!linkedAutoConnectStore.getSnapshot().joined.has(environmentId)) continue;
      await removeOnce(environmentId, () => linkedAutoConnectStore.leave(environmentId));
    }
    // Still joined, so the next plan joins it again with a fresh session.
    for (const environmentId of plan.rejoin) {
      if (!mayRejoin(environmentId)) continue;
      await removeOnce(environmentId, () => undefined);
    }
    for (const target of plan.connect) {
      if (inFlight.has(target.environmentId)) continue;
      // The user may have removed it by hand since this plan was made.
      if (linkedAutoConnectStore.getSnapshot().dismissed.has(target.environmentId)) continue;
      inFlight.add(target.environmentId);
      const joined = await join(target).finally(() => inFlight.delete(target.environmentId));
      if (joined) {
        linkedAutoConnectStore.clearWaits([target.environmentId]);
        linkedAutoConnectStore.join(target.environmentId);
      } else {
        linkedAutoConnectStore.wait(target.environmentId);
      }
    }
  });

  const applyKey = plan === null ? null : JSON.stringify({ plan, live: Object.fromEntries(live) });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- joining and leaving linked machines is connection work outside React, started when the links say so
  useEffect(() => {
    if (applyKey !== null) void apply(JSON.parse(applyKey).plan as LinkedAutoConnectPlan);
  }, [applyKey]);

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
