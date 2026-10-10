import type {
  PluginScheduleTargetEditorProps,
  PluginScheduleTargetHistoryProps,
} from "@t3tools/plugin-host-contract/web";
import { useEffect, useRef, useState } from "react";
import {
  taskLimit,
  type LibraryEntry,
  type ScheduleHistory,
  type SchedulePayload,
  type StartPreview,
  type WorkflowPermissions,
} from "../contracts.ts";
import { errorMessage, Labeled, noPermissions, type PageProps } from "./common.tsx";
import { authoringTimings, debounce } from "./timings.ts";
import { formatTime, runStateLabels, runStateVariant } from "./run.ts";

type Saved = Partial<SchedulePayload> & { readonly input?: Record<string, unknown> };
const savedPayload = (value: unknown): Saved =>
  typeof value === "object" && value !== null ? (value as Saved) : {};

function usePermissions(props: PageProps): WorkflowPermissions {
  const [permissions, setPermissions] = useState(noPermissions);
  useEffect(() => props.client.subscribePermissions(setPermissions), [props.client]);
  return permissions;
}

/**
 * Workflow selection and task fields inside the host's schedule editor. The host owns the
 * environment, project, timing and enabled state; each occurrence resolves the workflow as
 * saved when it is dispatched.
 */
export function ScheduleEditorView(props: PageProps & PluginScheduleTargetEditorProps) {
  // A project change starts a fresh selection; the saved payload belongs to its own project.
  return <ScheduleEditor key={`${props.environmentId}:${props.projectId}`} {...props} />;
}

function ScheduleEditor(props: PageProps & PluginScheduleTargetEditorProps) {
  const { client, projectId, connection, Badge, Button, Input, Select, Textarea } = props;
  const offline = connection === "disconnected";
  const permissions = usePermissions(props);
  const saved = savedPayload(props.payload);
  const legacyTask = typeof saved.input?.task === "string" ? saved.input.task : "";
  const [definitionId, setDefinitionId] = useState<string | null>(saved.definitionId ?? null);
  const [task, setTask] = useState((saved.task ?? legacyTask).slice(0, taskLimit));
  const [workspace, setWorkspace] = useState<SchedulePayload["workspace"]>(
    saved.workspace ?? "new-worktree",
  );
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<ReadonlyArray<LibraryEntry> | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [entriesAttempt, setEntriesAttempt] = useState(0);
  const [preview, setPreview] = useState<StartPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);

  useEffect(() => {
    if (query === search) return;
    return debounce(() => setSearch(query), authoringTimings.searchDelayMs);
  }, [query, search]);
  useEffect(() => {
    if (offline) return;
    let active = true;
    setEntriesError(null);
    client
      .library({ projectId, limit: 50, ...(search.trim() === "" ? {} : { query: search.trim() }) })
      .then(
        (page) => {
          if (active)
            setEntries(
              page.entries.filter((entry) => entry.definitionId !== null && !entry.duplicate),
            );
        },
        (cause: unknown) => {
          if (active) setEntriesError(errorMessage(cause));
        },
      );
    return () => {
      active = false;
    };
  }, [client, projectId, search, offline, entriesAttempt]);
  useEffect(() => {
    if (definitionId === null || offline) return;
    let active = true;
    setPreviewError(null);
    client.preview({ projectId, definitionId }).then(
      (value) => {
        if (active) setPreview(value);
      },
      (cause: unknown) => {
        if (active) {
          setPreview(null);
          setPreviewError(errorMessage(cause));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, definitionId, offline, previewAttempt]);

  // The host's callback may change identity every render; report only when the value changes.
  const onChange = useRef(props.onChange);
  useEffect(() => {
    onChange.current = props.onChange;
  });
  const ready =
    !offline &&
    permissions.schedule &&
    preview !== null &&
    preview.definitionId === definitionId &&
    preview.runnable;
  const payloadKey = ready ? JSON.stringify({ definitionId, task, workspace }) : null;
  useEffect(() => {
    onChange.current(payloadKey === null ? null : (JSON.parse(payloadKey) as SchedulePayload));
  }, [payloadKey]);

  const selectedEntry = entries?.find((entry) => entry.definitionId === definitionId);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <Labeled id="wf-schedule-search" label="Find a saved workflow">
            <Input
              id="wf-schedule-search"
              ariaLabel="Find a saved workflow"
              type="search"
              value={query}
              onChange={setQuery}
              placeholder="Name or identity"
            />
          </Labeled>
        </div>
        <div className="min-w-48 flex-1">
          <Labeled id="wf-schedule-workflow" label="Workflow">
            <Select
              id="wf-schedule-workflow"
              ariaLabel="Workflow"
              disabled={entries === null && definitionId === null}
              value={definitionId ?? ""}
              onChange={(value) => {
                setDefinitionId(value === "" ? null : value);
                setPreview(null);
              }}
              options={[
                ...(selectedEntry === undefined
                  ? [
                      {
                        value: definitionId ?? "",
                        label:
                          definitionId ??
                          (entries === null ? "Loading workflows…" : "Choose a workflow"),
                        disabled: true,
                      },
                    ]
                  : []),
                ...(entries ?? []).map((entry) => ({
                  value: entry.definitionId!,
                  label: `${entry.title ?? entry.definitionId}${entry.runnable ? "" : " · cannot run"}`,
                })),
              ]}
            />
          </Labeled>
        </div>
      </div>
      {entriesError === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Could not load workflows: {entriesError}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEntriesAttempt((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {entries !== null && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search.trim()
            ? "No saved workflows match this search."
            : "No saved workflows in this project yet."}
        </p>
      ) : null}
      {definitionId === null ? null : previewError !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Could not load this workflow: {previewError}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPreviewAttempt((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      ) : preview === null ? (
        offline ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the saved workflow…
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{preview.title}</span>
            <Badge variant="outline">Currently saved: revision {preview.revision}</Badge>
            {preview.runnable ? (
              <Badge variant="success">Runnable</Badge>
            ) : (
              <Badge variant="warning">Cannot run</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Each occurrence starts the workflow as it is saved when that occurrence runs, not
            necessarily revision {preview.revision}. Runs that already started keep their own
            snapshot.
          </p>
          {preview.reasons.length === 0 ? null : (
            <ul aria-label="Why this workflow cannot run" className="text-sm text-destructive">
              {preview.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Labeled
        id="wf-schedule-workspace"
        label="Workspace"
        hint={
          workspace === "new-worktree"
            ? "Each occurrence creates a new worktree from the project's current commit. Review branches always use their own frozen isolated workspaces."
            : "Each occurrence works directly in the project checkout, alongside any local changes."
        }
      >
        <Select
          id="wf-schedule-workspace"
          ariaLabel="Workspace"
          value={workspace}
          onChange={(value) => setWorkspace(value === "current" ? "current" : "new-worktree")}
          options={[
            { value: "new-worktree", label: "New worktree (recommended)" },
            { value: "current", label: "Current checkout" },
          ]}
        />
      </Labeled>
      <Labeled
        id="wf-schedule-task"
        label="Task"
        hint={`Optional. Recorded with each scheduled run and given to every agent as its input. ${task.length}/${taskLimit} characters.`}
      >
        <Textarea
          id="wf-schedule-task"
          ariaLabel="Task"
          rows={3}
          value={task}
          onChange={(value) => setTask(value.slice(0, taskLimit))}
          placeholder="Describe what each run should accomplish"
        />
      </Labeled>
      {saved.input !== undefined && saved.task === undefined ? (
        <p role="status" className="text-xs text-muted-foreground">
          This schedule was saved before free-form tasks and passes its original run input until you
          save it here.
        </p>
      ) : null}
      {!permissions.schedule ? (
        <p role="status" className="text-sm text-muted-foreground">
          This connection cannot schedule workflows. Pair with access to run agents.
        </p>
      ) : offline ? (
        <p role="status" className="text-sm text-muted-foreground">
          Disconnected. Saving waits until this environment reconnects.
        </p>
      ) : null}
    </div>
  );
}

const dispatchText = (item: ScheduleHistory["occurrences"][number]) =>
  item.dispatch === "pending"
    ? "Dispatch pending"
    : item.dispatch === "failed"
      ? `Dispatch failed${item.error ? `: ${item.error}` : ""}`
      : "Dispatched";

/**
 * Newest occurrences of one workflow schedule: the host's dispatch receipt beside the exact run
 * it started, read from that run's own snapshot.
 */
export function ScheduleHistoryView(props: PageProps & PluginScheduleTargetHistoryProps) {
  // Another schedule or environment never shows this one's last snapshot.
  return (
    <ScheduleHistoryList
      key={`${props.environmentId}:${props.projectId}:${props.scheduleId}`}
      {...props}
    />
  );
}

function ScheduleHistoryList(props: PageProps & PluginScheduleTargetHistoryProps) {
  const { client, projectId, scheduleId, revision, connection, Badge, Button } = props;
  const offline = connection === "disconnected";
  const [history, setHistory] = useState<ScheduleHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const shown = useRef<ScheduleHistory | null>(null);
  // Runs open in their own project; one that was removed cannot be opened.
  // "unknown" when the list could not be read: the run page then explains its own state.
  const [projects, setProjects] = useState<ReadonlySet<string> | "unknown" | null>(null);
  useEffect(() => {
    if (offline) return;
    let active = true;
    client.projects().then(
      (list) => {
        if (active) setProjects(new Set(list.map((project) => project.id)));
      },
      () => {
        if (active) setProjects("unknown");
      },
    );
    return () => {
      active = false;
    };
  }, [client, offline, revision]);
  useEffect(() => {
    if (offline) return;
    let active = true;
    setError(null);
    client.scheduleHistory({ projectId, scheduleId }).then(
      (value) => {
        if (!active) return;
        shown.current = value;
        setHistory(value);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, scheduleId, revision, offline, attempt]);
  // Workflow outcomes change without a dispatch: re-read while a listed run is still moving.
  useEffect(() => {
    if (offline) return;
    return client.subscribeRuns(
      projectId,
      (runs) => {
        const current = shown.current;
        if (current === null) return;
        const states = new Map(runs.map((run) => [run.id, run.state]));
        // Dispatch receipts change with the host's schedule row (the `revision` prop).
        const changed = current.occurrences.some(
          (item) =>
            item.run !== null &&
            states.has(item.run.id) &&
            states.get(item.run.id) !== item.run.state,
        );
        if (changed) setAttempt((value) => value + 1);
      },
      () => undefined,
    );
  }, [client, projectId, offline]);

  return (
    <section aria-label="Scheduled workflow occurrences" className="flex flex-col gap-3 text-sm">
      {offline ? (
        <p role="status" className="text-muted-foreground">
          {history === null
            ? "Disconnected. The history loads when this environment reconnects."
            : "Disconnected. Showing the last loaded history; it may be out of date."}
        </p>
      ) : null}
      {error === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-destructive">
          <span>Could not load the history: {error}</span>
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      {history === null ? (
        error === null && !offline ? (
          <p role="status" className="text-muted-foreground">
            Loading occurrences…
          </p>
        ) : null
      ) : history.schedule === null ? (
        <p role="status" className="text-muted-foreground">
          Workflows does not own this schedule in this project, so it has no workflow history here.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Workflow</dt>
            <dd className="break-words">
              {history.current === null
                ? `${history.schedule.payload?.definitionId ?? "Unknown"} is no longer saved in this project. Later occurrences fail until you choose another workflow.`
                : `${history.current.title}: each occurrence uses the revision saved when it runs (currently ${history.current.revision}).`}
            </dd>
            {history.current !== null && !history.current.runnable ? (
              <>
                <dt className="text-muted-foreground">Problems</dt>
                <dd className="break-words text-destructive">
                  Later occurrences fail until this is fixed: {history.current.reasons.join(" ")}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Task</dt>
            <dd className="whitespace-pre-wrap break-words">
              {history.schedule.payload !== null
                ? history.schedule.payload.task.trim() || "None"
                : history.schedule.legacyInput !== null
                  ? `Original run input: ${JSON.stringify(history.schedule.legacyInput)}`
                  : "Not readable"}
            </dd>
            {history.schedule.payload !== null ? (
              <>
                <dt className="text-muted-foreground">Workspace</dt>
                <dd>
                  {history.schedule.payload.workspace === "current"
                    ? "Current checkout"
                    : "New worktree for each occurrence"}
                </dd>
              </>
            ) : null}
          </dl>
          {history.occurrences.length === 0 ? (
            <p className="text-muted-foreground">No occurrences yet.</p>
          ) : (
            <ol aria-label="Occurrences" className="divide-y divide-border">
              {history.occurrences.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span>{formatTime(Date.parse(item.startedAt))}</span>
                      <Badge
                        variant={
                          item.dispatch === "failed"
                            ? "error"
                            : item.dispatch === "pending"
                              ? "info"
                              : "outline"
                        }
                      >
                        {item.dispatch === "succeeded"
                          ? "Dispatched"
                          : item.dispatch === "failed"
                            ? "Dispatch failed"
                            : "Dispatch pending"}
                      </Badge>
                      {item.run === null ? null : (
                        <Badge variant={runStateVariant(item.run.state)}>
                          Workflow: {runStateLabels[item.run.state]}
                        </Badge>
                      )}
                    </span>
                    <span className="break-words text-xs text-muted-foreground">
                      {item.run !== null
                        ? `${item.run.definition.title} · revision ${item.run.definition.revision} (snapshot taken at start)`
                        : item.dispatch === "failed"
                          ? `${dispatchText(item)}. No run was started.`
                          : item.dispatch === "pending"
                            ? "The host has not confirmed this dispatch; it is retried with the same identity, so it starts at most one run."
                            : "No run is recorded for this occurrence."}
                    </span>
                  </div>
                  {item.run === null ? null : projects !== null &&
                    projects !== "unknown" &&
                    !projects.has(item.run.projectId) ? (
                    <span className="text-xs text-muted-foreground">
                      Its project is no longer in this environment.
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      // Waits for the environment's projects, so a removed project is never opened.
                      disabled={projects === null}
                      ariaLabel={`Open the run from ${formatTime(Date.parse(item.startedAt))}`}
                      onClick={() =>
                        props.navigate({
                          pageId: "workflows.runs",
                          projectId: item.run!.projectId,
                          state: { run: item.run!.id },
                        })
                      }
                    >
                      Open run
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {history.more ? (
            <p className="text-xs text-muted-foreground">
              Showing the {history.occurrences.length} most recent occurrences; older ones are not
              listed here. Every run remains in the workflow run history.
            </p>
          ) : null}
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={offline}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Refresh
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
