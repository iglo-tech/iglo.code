import type { EnvironmentId } from "@t3tools/contracts";

const MARKS_KEY = "iglo.code:linked-auto-connect:v1";
// A machine this device could not reach or pair with is tried again after a while, not each render.
const RETRY_AFTER_MS = 10 * 60_000;

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

const current = (): LinkedAutoConnectState =>
  (state ??= { marks: readMarks(), waiting: new Set() });

function update(next: LinkedAutoConnectState) {
  state = next;
  for (const listener of listeners) listener();
}

export const linkedAutoConnectStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: current,
  setMarked: (environmentIds: ReadonlyArray<EnvironmentId>, marked: boolean) => {
    const marks = new Set(current().marks);
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
  /** Leaves `environmentId` alone for a while; the wait ends on its own. */
  wait: (environmentId: EnvironmentId) => {
    update({ ...current(), waiting: new Set(current().waiting).add(environmentId) });
    setTimeout(() => {
      const waiting = new Set(current().waiting);
      waiting.delete(environmentId);
      update({ ...current(), waiting });
    }, RETRY_AFTER_MS);
  },
};
