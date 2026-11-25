import type { EnvironmentId } from "@t3tools/contracts";

const MARKS_KEY = "iglo.code:linked-auto-connect:v1";
// A machine that could not be joined waits longer each time, up to a few hours.
const FIRST_WAIT_MS = 2 * 60_000;
const LONGEST_WAIT_MS = 4 * 60 * 60_000;

export interface LinkedAutoConnectState {
  /** Machines this device joined through a link, so it may leave them when the link goes. */
  readonly marks: ReadonlySet<EnvironmentId>;
  /** Machines that could not be joined lately. */
  readonly waiting: ReadonlySet<EnvironmentId>;
}

function readMarks(): ReadonlySet<EnvironmentId> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(MARKS_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is EnvironmentId => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

let state: LinkedAutoConnectState | null = null;
const listeners = new Set<() => void>();
const timers = new Map<EnvironmentId, { handle: ReturnType<typeof setTimeout>; ms: number }>();
// Where a machine answered its last pairing, so a later try checks them before asking for a code.
const knownUrls = new Map<EnvironmentId, ReadonlyArray<string>>();

const current = (): LinkedAutoConnectState =>
  (state ??= { marks: readMarks(), waiting: new Set() });

function update(next: LinkedAutoConnectState) {
  state = next;
  for (const listener of listeners) listener();
}

// Another tab joined or left a machine.
const onStorage = (event: StorageEvent) => {
  if (event.key === MARKS_KEY) update({ ...current(), marks: readMarks() });
};

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
  setMarked: (environmentIds: ReadonlyArray<EnvironmentId>, marked: boolean) => {
    // Read again first: another tab may have written since this one last did.
    const marks = new Set(readMarks());
    for (const id of environmentIds) {
      if (marked) marks.add(id);
      else marks.delete(id);
    }
    try {
      window.localStorage.setItem(MARKS_KEY, JSON.stringify([...marks]));
    } catch {
      // Without storage the device still joins linked machines; it only cannot leave them later.
    }
    update({ ...current(), marks });
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
};
