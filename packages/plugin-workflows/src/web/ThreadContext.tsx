import { RotateCcwIcon, RouteIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ThreadLink } from "../contracts.ts";
import type { PageProps } from "./common.tsx";
import { StatusIcon } from "./kinds.tsx";
import { isActive, phaseLabels, phaseStatus } from "./run.ts";

/**
 * Identifies the workflow run and attempt a native thread was launched for. The association is
 * historical: later messages in the thread do not change that attempt.
 */
export function ThreadContextView(props: PageProps) {
  // Each thread has its own strip state; switching threads never shows the previous link.
  return (
    <ThreadStrip key={`${props.environmentId}:${props.projectId}:${props.threadId}`} {...props} />
  );
}

function ThreadStrip(props: PageProps) {
  const { client, projectId, threadId, connection, Button, Badge } = props;
  const [link, setLink] = useState<ThreadLink | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const offline = connection === "disconnected";
  // Live: the owning run's commits update the attempt's phase and report status.
  useEffect(() => {
    if (projectId === null || threadId === null || offline) return;
    setError(null);
    return client.watchThread(
      { projectId, threadId },
      (value) => {
        setError(null);
        setLink(value);
      },
      setError,
    );
  }, [client, projectId, threadId, offline, attempt]);
  if (projectId === null) return null;
  // Without a live subscription the last link stays visible, marked as possibly out of date.
  const stale = offline || error !== null;
  const retry = (
    <Button
      size="icon-xs"
      variant="ghost"
      ariaLabel="Retry"
      tooltip="Retry workflow link"
      onClick={() => setAttempt((value) => value + 1)}
    >
      <RotateCcwIcon />
    </Button>
  );
  if (error !== null && !link)
    return (
      <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
        <WorkflowIcon aria-hidden className="size-3.5" />
        <span className="max-sm:hidden">Workflow link unavailable</span>
        {retry}
      </span>
    );
  if (!link) return null;
  const state = {
    run: link.runId,
    node: link.nodeId,
    attempt: link.attemptId,
    ...(link.branchId === null ? {} : { branch: link.branchId }),
  };
  const settled = !isActive(link);
  return (
    <span
      role="group"
      aria-label="Workflow context"
      className="flex min-w-0 items-center gap-0.5 text-xs"
    >
      <Button
        size="xs"
        variant="ghost"
        ariaLabel="Open workflow run"
        tooltip="Open workflow run"
        onClick={() => props.navigate({ pageId: "workflows.runs", projectId, state })}
      >
        <WorkflowIcon />
        <span className="max-w-56 truncate max-md:max-w-28">
          {link.workflowTitle} · {link.nodeTitle}
        </span>
      </Button>
      <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
        <StatusIcon status={phaseStatus(link.phase)} className="size-3.5" />
        <span className="truncate max-lg:sr-only">
          {phaseLabels[link.phase]}
          {link.generation > 1 ? ` · generation ${link.generation}` : ""}
          {link.reportAccepted ? " · report accepted" : ""}
        </span>
        {/* The link is historical: a settled attempt does not take later manual messages. */}
        {settled ? (
          <span className="sr-only"> · later messages are not part of this attempt</span>
        ) : null}
      </span>
      {stale ? <Badge variant="warning">Last loaded state</Badge> : null}
      <Button
        size="icon-xs"
        variant="ghost"
        ariaLabel="View route"
        tooltip="View route"
        onClick={() =>
          props.navigate({
            pageId: "workflows.runs",
            projectId,
            state: { ...state, focus: "route" },
          })
        }
      >
        <RouteIcon />
      </Button>
      {error !== null ? retry : null}
    </span>
  );
}
