import { environmentAtomList } from "./environmentAtomList";
import { serverEnvironment } from "./server";

/** Live scheduled tasks per connected environment, shared by the sidebar and Settings. */
export const scheduledTasksListAtom = environmentAtomList(
  "web-scheduled-tasks-list",
  (environmentId) => serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);
