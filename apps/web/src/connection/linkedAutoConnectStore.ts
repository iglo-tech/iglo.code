import type { EnvironmentId, PeerLinkName } from "@t3tools/contracts";

const STORAGE_KEY = "iglo.code:linked-machines:v1";
// A machine that could not be joined waits longer each time, up to a few hours.
const FIRST_WAIT_MS = 2 * 60_000;
const LONGEST_WAIT_MS = 4 * 60 * 60_000;

export interface LinkedAutoConnectState {
  /** Machines this device joined through a link, so it may leave them when the link goes. */
  readonly joined: ReadonlySet<EnvironmentId>;
  /** Linked machines the user removed from this device, kept away while still linked. */
  readonly dismissed: ReadonlySet<EnvironmentId>;
  /** What each machine last linked to, for while it is asleep, offline or switched off. */
  readonly links: ReadonlyMap<EnvironmentId, ReadonlyArray<PeerLinkName>>;
  /** Machines that could not be joined lately. */
  readonly waiting: ReadonlySet<EnvironmentId>;
}

type Persisted = Pick<LinkedAutoConnectState, "joined" | "dismissed" | "links">;

const ids = (value: unknown): Set<EnvironmentId> =>
  new Set(
    Array.isArray(value) ? value.filter((id): id is EnvironmentId => typeof id === "string") : [],
  );

function readPersisted(): Persisted {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    const links = new Map<EnvironmentId, ReadonlyArray<PeerLinkName>>();
    if (typeof parsed.links === "object" && parsed.links !== null) {
      for (const [id, list] of Object.entries(parsed.links)) {
        if (Array.isArray(list)) links.set(id as EnvironmentId, list as PeerLinkName[]);
      }
    }
    return { joined: ids(parsed.joined), dismissed: ids(parsed.dismissed), links };
  } catch {
    return { joined: new Set(), dismissed: new Set(), links: new Map() };
  }
}

let state: LinkedAutoConnectState | null = null;
const listeners = new Set<() => void>();
const timers = new Map<EnvironmentId, { handle: ReturnType<typeof setTimeout>; ms: number }>();
// Where a machine answered its last pairing, so a later try checks them before asking for a code.
const knownUrls = new Map<EnvironmentId, ReadonlyArray<string>>();

const current = (): LinkedAutoConnectState =>
  (state ??= { ...readPersisted(), waiting: new Set() });

function update(next: LinkedAutoConnectState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Applies `change` to what is stored now, since another tab may have written since. */
function persist(
  change: (next: {
    joined: Set<EnvironmentId>;
    dismissed: Set<EnvironmentId>;
    links: Map<EnvironmentId, ReadonlyArray<PeerLinkName>>;
  }) => void,
) {
  const stored = readPersisted();
  const next = {
    joined: new Set(stored.joined),
    dismissed: new Set(stored.dismissed),
    links: new Map(stored.links),
  };
  change(next);
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        joined: [...next.joined],
        dismissed: [...next.dismissed],
        links: Object.fromEntries(next.links),
      }),
    );
  } catch {
    // Without storage the device still joins linked machines; it only forgets them on reload.
  }
  update({ ...current(), ...next });
}

const onStorage = (event: StorageEvent) => {
  if (event.key === STORAGE_KEY) update({ ...current(), ...readPersisted() });
};

const sameLinks = (a: ReadonlyArray<PeerLinkName> | undefined, b: ReadonlyArray<PeerLinkName>) =>
  a !== undefined &&
  a.length === b.length &&
  a.every((link, index) => link.environmentId === b[index]?.environmentId);

export const linkedAutoConnectStore = {
  subscribe: (listener: () => void) => {
    if (listeners.size === 0) window.addEventListener("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) window.removeEventListener("storage", onStorage);
    };
  },
  getSnapshot: current,
  /** Joined through a link. */
  join: (environmentId: EnvironmentId) =>
    persist((next) => {
      next.joined.add(environmentId);
      next.dismissed.delete(environmentId);
    }),
  /** Paired by hand: the machine is this device's own, so no link going takes it away. */
  own: (environmentId: EnvironmentId) => {
    // Read what is stored, not this tab's copy: only the tab acting for the device follows it.
    const { joined, dismissed } = readPersisted();
    if (!joined.has(environmentId) && !dismissed.has(environmentId)) return;
    persist((next) => {
      next.joined.delete(environmentId);
      next.dismissed.delete(environmentId);
    });
  },
  /**
   * Removed from this device by the user: kept away while still linked. Recorded before the
   * removal, so the machine is never rejoined in between; the returned undo is for a failed one.
   */
  dismiss: (environmentId: EnvironmentId) => {
    const wasJoined = readPersisted().joined.has(environmentId);
    persist((next) => {
      next.joined.delete(environmentId);
      next.dismissed.add(environmentId);
    });
    return () =>
      persist((next) => {
        next.dismissed.delete(environmentId);
        if (wasJoined) next.joined.add(environmentId);
      });
  },
  /** Left because no link reaches it any more; it stays recorded as joined, see the planner. */
  leave: (environmentId: EnvironmentId) =>
    persist((next) => {
      next.links.delete(environmentId);
    }),
  clear: (input: {
    readonly joined: ReadonlyArray<EnvironmentId>;
    readonly dismissed: ReadonlyArray<EnvironmentId>;
  }) => {
    if (input.joined.length === 0 && input.dismissed.length === 0) return;
    persist((next) => {
      for (const id of input.joined) next.joined.delete(id);
      for (const id of input.dismissed) next.dismissed.delete(id);
    });
  },
  /** Keeps what each machine links to now, written only when it changed. */
  rememberLinks: (live: ReadonlyMap<EnvironmentId, ReadonlyArray<PeerLinkName>>) => {
    const changed = [...live].filter(([id, links]) => !sameLinks(current().links.get(id), links));
    if (changed.length === 0) return;
    persist((next) => {
      for (const [id, links] of changed) next.links.set(id, links);
    });
  },
  /** Leaves `environmentId` alone for a while, longer each time; the wait ends on its own. */
  wait: (environmentId: EnvironmentId) => {
    const previous = timers.get(environmentId);
    if (previous !== undefined) clearTimeout(previous.handle);
    const ms = previous === undefined ? FIRST_WAIT_MS : Math.min(previous.ms * 2, LONGEST_WAIT_MS);
    const handle = setTimeout(() => {
      const waiting = new Set(current().waiting);
      waiting.delete(environmentId);
      update({ ...current(), waiting });
    }, ms);
    timers.set(environmentId, { handle, ms });
    update({ ...current(), waiting: new Set(current().waiting).add(environmentId) });
  },
  /** Starts afresh: the machine joined, or its link went. */
  clearWaits: (environmentIds: ReadonlyArray<EnvironmentId>) => {
    if (environmentIds.length === 0) return;
    for (const id of environmentIds) {
      const timer = timers.get(id);
      if (timer !== undefined) clearTimeout(timer.handle);
      timers.delete(id);
      knownUrls.delete(id);
    }
    const waiting = new Set(current().waiting);
    for (const id of environmentIds) waiting.delete(id);
    if (waiting.size !== current().waiting.size) update({ ...current(), waiting });
  },
  knownUrls: (environmentId: EnvironmentId) => knownUrls.get(environmentId),
  rememberUrls: (environmentId: EnvironmentId, urls: ReadonlyArray<string>) => {
    knownUrls.set(environmentId, urls);
  },
  forgetUrls: (environmentId: EnvironmentId) => {
    knownUrls.delete(environmentId);
  },
};
