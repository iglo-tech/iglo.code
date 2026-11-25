import type { EnvironmentId, PeerLinkName } from "@t3tools/contracts";

/** A machine this device has registered, with what it links to as far as that is known. */
export interface LinkingEnvironment {
  readonly environmentId: EnvironmentId;
  /** What it links to now, else what it last did; null when that was never known. */
  readonly links: ReadonlyArray<PeerLinkName> | null;
  /** Whether this device may ask it for a pairing with a machine it links to. */
  readonly mayPair: boolean;
  /** The machine serving this app, which is never joined or left through a link. */
  readonly primary?: boolean;
  /** Its host refused this device's credential. */
  readonly refused?: boolean;
}

export interface LinkedAutoConnectPlan {
  /** Machines to connect this device to, each through a machine that links to it. */
  readonly connect: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly via: EnvironmentId;
    readonly label: string;
  }>;
  /** Joined machines this device's own machines no longer reach. */
  readonly forget: ReadonlyArray<EnvironmentId>;
  /** Joined machines whose session was refused, removed so they are joined afresh. */
  readonly rejoin: ReadonlyArray<EnvironmentId>;
  readonly clearJoined: ReadonlyArray<EnvironmentId>;
  readonly clearDismissed: ReadonlyArray<EnvironmentId>;
  readonly clearWaits: ReadonlyArray<EnvironmentId>;
}

export const EMPTY_LINKED_AUTO_CONNECT_PLAN: LinkedAutoConnectPlan = {
  connect: [],
  forget: [],
  rejoin: [],
  clearJoined: [],
  clearDismissed: [],
  clearWaits: [],
};

/**
 * Roots are the machines this device holds on its own (not `joined`, or the primary one); the
 * device holds every machine their links reach, chains included, except ones the user removed
 * (`dismissed`) while they are still reached. A joined machine no root reaches is left, even
 * offline. Nothing is left while a reached machine's links were never known.
 */
export function planLinkedAutoConnect(input: {
  readonly environments: ReadonlyArray<LinkingEnvironment>;
  readonly joined: ReadonlySet<EnvironmentId>;
  readonly dismissed: ReadonlySet<EnvironmentId>;
  /** Machines that could not be joined lately, left alone until their wait is over. */
  readonly waiting?: ReadonlySet<EnvironmentId>;
}): LinkedAutoConnectPlan {
  // Before the catalog loads, nothing is known, not "nothing is held".
  if (input.environments.length === 0) return EMPTY_LINKED_AUTO_CONNECT_PLAN;
  const byId = new Map(input.environments.map((machine) => [machine.environmentId, machine]));
  const isJoined = (id: EnvironmentId) => input.joined.has(id) && byId.get(id)?.primary !== true;
  const visited = new Set<EnvironmentId>();
  const queue = input.environments.filter((machine) => !isJoined(machine.environmentId));
  const reached = new Map<EnvironmentId, { via: EnvironmentId | null; label: string }>();
  let unknown = false;
  for (let machine = queue.shift(); machine !== undefined; machine = queue.shift()) {
    if (visited.has(machine.environmentId)) continue;
    visited.add(machine.environmentId);
    if (machine.links === null) {
      unknown = true;
      continue;
    }
    // A machine refusing this device cannot pair it anywhere.
    const mayPair = machine.mayPair && machine.refused !== true;
    for (const link of machine.links) {
      const known = reached.get(link.environmentId);
      if (known === undefined || (known.via === null && mayPair)) {
        reached.set(link.environmentId, {
          via: mayPair ? machine.environmentId : null,
          label: link.label,
        });
      }
      const next = byId.get(link.environmentId);
      if (next !== undefined && !visited.has(next.environmentId)) queue.push(next);
    }
  }
  const held = (id: EnvironmentId) => visited.has(id) || reached.has(id);

  const connect = [...reached].flatMap(([environmentId, { via, label }]) =>
    via === null ||
    byId.has(environmentId) ||
    input.dismissed.has(environmentId) ||
    input.waiting?.has(environmentId) === true
      ? []
      : [{ environmentId, via, label }],
  );
  const rejoin = input.environments
    .filter(
      (machine) =>
        machine.refused === true && isJoined(machine.environmentId) && held(machine.environmentId),
    )
    .map((machine) => machine.environmentId);
  const clearJoined = [...input.joined].filter((id) => byId.get(id)?.primary === true);
  const clearDismissed = [...input.dismissed].filter((id) => byId.has(id));
  if (unknown) {
    return { ...EMPTY_LINKED_AUTO_CONNECT_PLAN, connect, rejoin, clearJoined, clearDismissed };
  }
  const unheldJoined = [...input.joined].filter((id) => isJoined(id) && !held(id));
  return {
    connect,
    forget: unheldJoined.filter((id) => byId.has(id)),
    rejoin,
    clearJoined: [...clearJoined, ...unheldJoined.filter((id) => !byId.has(id))],
    clearDismissed: [
      ...clearDismissed,
      ...[...input.dismissed].filter((id) => !byId.has(id) && !held(id)),
    ],
    clearWaits: [...(input.waiting ?? [])].filter((id) => !reached.has(id)),
  };
}
