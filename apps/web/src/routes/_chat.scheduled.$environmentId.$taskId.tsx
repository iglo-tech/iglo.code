import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";

import { ScheduledTaskPage } from "../components/settings/ScheduledTasksSettings";

function ScheduledTaskRoute() {
  const params = Route.useParams();
  return (
    <ScheduledTaskPage
      environmentId={EnvironmentId.make(params.environmentId)}
      taskId={ScheduledTaskId.make(params.taskId)}
    />
  );
}

export const Route = createFileRoute("/_chat/scheduled/$environmentId/$taskId")({
  component: ScheduledTaskRoute,
});
