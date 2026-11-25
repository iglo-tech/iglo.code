import type { EnvironmentId, PeerLinkName } from "@t3tools/contracts";

/** A machine this device is connected to, with what it links to once its list has loaded. */
export interface LinkingEnvironment {
  readonly environmentId: EnvironmentId;
  /** Null until its link list has loaded, or while it cannot be read. */
  readonly links: ReadonlyArray<PeerLinkName> | null;
  /** Whether this device may ask it for a pairing with a machine it links to. */
  readonly mayPair: boolean;
}

export interface LinkedAutoConnectPlan {
  /** Machines to connect this device to, each through a machine that links to it. */
  readonly connect: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly via: EnvironmentId;
    readonly label: string;
  }>;
  /** Machines this device joined through a link that no machine here links to anymore. */
  readonly forget: ReadonlyArray<EnvironmentId>;
  /** Marks to drop: the machine is gone from this device and no link reaches it. */
  readonly clearMarks: ReadonlyArray<EnvironmentId>;
}

/**
 * A marked machine still linked but no longer registered was removed by hand, so it stays removed
 * until its link goes. Nothing is left while any registered machine's links are unknown, so an
 * offline machine never makes the device drop what it reaches.
 */
export function planLinkedAutoConnect(input: {
  readonly registered: ReadonlyArray<EnvironmentId>;
  readonly linking: ReadonlyArray<LinkingEnvironment>;
  readonly marked: ReadonlySet<EnvironmentId>;
  /** Machines that could not be joined lately, left alone until their wait is over. */
  readonly waiting?: ReadonlySet<EnvironmentId>;
}): LinkedAutoConnectPlan {
  const registered = new Set(input.registered);
  const linkedBy = new Map<EnvironmentId, { via: EnvironmentId | null; label: string }>();
  for (const machine of input.linking) {
    if (!registered.has(machine.environmentId)) continue;
    for (const link of machine.links ?? []) {
      const known = linkedBy.get(link.environmentId);
      if (known === undefined || (known.via === null && machine.mayPair)) {
        linkedBy.set(link.environmentId, {
          via: machine.mayPair ? machine.environmentId : null,
          label: link.label,
        });
      }
    }
  }
  const loading = new Set(
    input.linking.filter((machine) => machine.links === null).map((m) => m.environmentId),
  );
  const allKnown = input.registered.every(
    (id) => !loading.has(id) && input.linking.some((machine) => machine.environmentId === id),
  );

  const connect = [...linkedBy].flatMap(([environmentId, { via, label }]) =>
    via === null ||
    registered.has(environmentId) ||
    input.marked.has(environmentId) ||
    input.waiting?.has(environmentId) === true
      ? []
      : [{ environmentId, via, label }],
  );
  if (!allKnown) return { connect, forget: [], clearMarks: [] };
  const unlinked = [...input.marked].filter((id) => !linkedBy.has(id));
  return {
    connect,
    forget: unlinked.filter((id) => registered.has(id)),
    clearMarks: unlinked.filter((id) => !registered.has(id)),
  };
}
