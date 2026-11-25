import type { EnvironmentId, PeerLinkName } from "@t3tools/contracts";

/** A machine this device has registered, with what it links to once that is known. */
export interface LinkingEnvironment {
  readonly environmentId: EnvironmentId;
  /** Null while unknown: loading, offline, switched off, or its links are paused. */
  readonly links: ReadonlyArray<PeerLinkName> | null;
  /** Whether this device may ask it for a pairing with a machine it links to. */
  readonly mayPair: boolean;
  /** The machine serving this app, which is never joined or left through a link. */
  readonly primary?: boolean;
}

export interface LinkedAutoConnectPlan {
  /** Machines to connect this device to, each through a machine that links to it. */
  readonly connect: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly via: EnvironmentId;
    readonly label: string;
  }>;
  /** Machines this device joined through a link that its own machines no longer reach. */
  readonly forget: ReadonlyArray<EnvironmentId>;
  /** Marks to drop: the machine is gone from this device and no link reaches it. */
  readonly clearMarks: ReadonlyArray<EnvironmentId>;
  /** Waits to drop: their machine is no longer linked, so a new link starts afresh. */
  readonly clearWaits: ReadonlyArray<EnvironmentId>;
}

/**
 * Roots are the machines this device was paired with itself (unmarked, or the primary one); the
 * device holds every machine their links reach, chains included. A marked machine no root reaches
 * is left, even offline. A marked one still reached but no longer registered was removed by hand
 * and stays removed. Nothing is left while a reached machine's links are unknown.
 */
export function planLinkedAutoConnect(input: {
  readonly environments: ReadonlyArray<LinkingEnvironment>;
  readonly marked: ReadonlySet<EnvironmentId>;
  /** Machines that could not be joined lately, left alone until their wait is over. */
  readonly waiting?: ReadonlySet<EnvironmentId>;
}): LinkedAutoConnectPlan {
  // Before the catalog loads, nothing is known, not "nothing is held".
  if (input.environments.length === 0) {
    return { connect: [], forget: [], clearMarks: [], clearWaits: [] };
  }
  const byId = new Map(input.environments.map((machine) => [machine.environmentId, machine]));
  const isRoot = (machine: LinkingEnvironment) =>
    machine.primary === true || !input.marked.has(machine.environmentId);
  const visited = new Set<EnvironmentId>();
  const queue = input.environments.filter(isRoot);
  const reached = new Map<EnvironmentId, { via: EnvironmentId | null; label: string }>();
  let unknown = false;
  for (let machine = queue.shift(); machine !== undefined; machine = queue.shift()) {
    if (visited.has(machine.environmentId)) continue;
    visited.add(machine.environmentId);
    if (machine.links === null) {
      unknown = true;
      continue;
    }
    for (const link of machine.links) {
      const known = reached.get(link.environmentId);
      if (known === undefined || (known.via === null && machine.mayPair)) {
        reached.set(link.environmentId, {
          via: machine.mayPair ? machine.environmentId : null,
          label: link.label,
        });
      }
      const next = byId.get(link.environmentId);
      if (next !== undefined && !visited.has(next.environmentId)) queue.push(next);
    }
  }

  const connect = [...reached].flatMap(([environmentId, { via, label }]) =>
    via === null ||
    byId.has(environmentId) ||
    input.marked.has(environmentId) ||
    input.waiting?.has(environmentId) === true
      ? []
      : [{ environmentId, via, label }],
  );
  const primaryMarks = input.environments
    .filter((machine) => machine.primary === true && input.marked.has(machine.environmentId))
    .map((machine) => machine.environmentId);
  if (unknown) return { connect, forget: [], clearMarks: primaryMarks, clearWaits: [] };
  const held = (id: EnvironmentId) => visited.has(id) || reached.has(id);
  const unheld = [...input.marked].filter((id) => !held(id) && byId.get(id)?.primary !== true);
  return {
    connect,
    forget: unheld.filter((id) => byId.has(id)),
    clearMarks: [...primaryMarks, ...unheld.filter((id) => !byId.has(id))],
    clearWaits: [...(input.waiting ?? [])].filter((id) => !reached.has(id)),
  };
}
