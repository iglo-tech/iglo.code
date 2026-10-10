import type { ProjectId } from "@t3tools/plugin-host-contract/schema";
import { BotIcon, GitBranchIcon, FolderIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  taskLimit,
  type LibraryEntry,
  type StartPreview,
  type StartSavedInput,
  type WorkflowPermissions,
} from "../contracts.ts";
import { errorMessage, rejected, type PageProps } from "./common.tsx";
import { authoringTimings, debounce } from "./timings.ts";
import { short } from "./run.ts";

type Intent = Omit<StartSavedInput, "environmentId" | "projectId">;
const intentKey = (projectId: ProjectId) => `start:${projectId}`;
/** Stable for one start intent; generated without `crypto.randomUUID`, which insecure origins lack. */
const requestId = () =>
  `start-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
function readIntent(props: PageProps, projectId: ProjectId): Intent | null {
  const raw = props.drafts.read(intentKey(projectId));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Intent>;
    return typeof value.clientRequestId === "string" &&
      typeof value.definitionId === "string" &&
      typeof value.revision === "number" &&
      typeof value.task === "string" &&
      (value.workspace === "new-worktree" || value.workspace === "current")
      ? (value as Intent)
      : null;
  } catch {
    return null;
  }
}

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string };

const entryLabel = (entry: LibraryEntry) => entry.title ?? entry.definitionId ?? entry.source;

/**
 * The one Run workflow dialog for project and library entry points. The server resolves the
 * saved identity and revision; this form only names them and the free-form task.
 */
export function StartDialog({
  props,
  projectId,
  projectTitle,
  permissions,
  onClose,
}: {
  readonly props: PageProps;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly permissions: WorkflowPermissions;
  readonly onClose: () => void;
}) {
  const { client, connection, Button, Badge, Combobox, SegmentedControl, Textarea, Alert } = props;
  const offline = connection === "disconnected";
  const [intent, setIntent] = useState<Intent | null>(() => readIntent(props, projectId));
  const [definitionId, setDefinitionId] = useState<string | null>(
    intent?.definitionId ?? props.pageState.workflow ?? null,
  );
  const [task, setTask] = useState(intent?.task ?? "");
  const [workspace, setWorkspace] = useState<Intent["workspace"]>(
    intent?.workspace ?? "new-worktree",
  );
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<ReadonlyArray<LibraryEntry> | null>(null);
  // The chosen entry stays nameable while a search narrows it out of the results.
  const [chosen, setChosen] = useState<LibraryEntry | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [entriesAttempt, setEntriesAttempt] = useState(0);
  const [preview, setPreview] = useState<StartPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const inFlight = useRef(false);

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

  const forget = useCallback(() => {
    props.drafts.remove(intentKey(projectId));
    setIntent(null);
  }, [props.drafts, projectId]);
  const submit = useCallback(
    (request: Intent) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStatus({ kind: "starting" });
      client.startSaved({ projectId, ...request }).then(
        (run) => {
          inFlight.current = false;
          forget();
          setStatus({ kind: "idle" });
          props.navigate({ pageId: "workflows.runs", projectId, state: { run: run.id } });
        },
        (cause: unknown) => {
          inFlight.current = false;
          // A rejected request committed nothing, so its identity is released; the task stays.
          if (rejected(cause, "start")) {
            forget();
            setStatus({ kind: "rejected", message: errorMessage(cause) });
            setPreviewAttempt((value) => value + 1);
          } else setStatus({ kind: "failed", message: errorMessage(cause) });
        },
      );
    },
    [client, projectId, forget, props],
  );
  // A stored intent is reconciled once connected: the server returns its run if it started.
  // It is resent automatically only when this dialog was opened for the same workflow;
  // opening Run for another workflow shows it for an explicit Retry or Discard instead.
  const reconciled = useRef(false);
  const requested = props.pageState.workflow;
  const other = intent !== null && requested !== undefined && requested !== intent.definitionId;
  useEffect(() => {
    // Each reconnection reconciles a still-pending intent once.
    if (offline) reconciled.current = false;
    if (offline || intent === null || other || reconciled.current || !permissions.start) return;
    reconciled.current = true;
    submit(intent);
  }, [offline, intent, other, permissions.start, submit]);

  const run = () => {
    // A pending intent is resent unchanged; the server answers from its receipt first.
    if (intent !== null) return submit(intent);
    if (preview === null) return;
    const next: Intent = {
      clientRequestId: requestId(),
      definitionId: preview.definitionId,
      revision: preview.revision,
      task,
      workspace,
    };
    if (!props.drafts.write(intentKey(projectId), JSON.stringify(next))) {
      setStatus({
        kind: "rejected",
        message: "This browser could not keep the start request. Free some site storage.",
      });
      return;
    }
    // This send is the intent's reconciliation; only a reconnect or reopening resends it.
    reconciled.current = true;
    setIntent(next);
    submit(next);
  };
  const discard = () => {
    forget();
    setStatus({ kind: "idle" });
    // The dialog returns to the workflow it was opened for.
    if (requested !== undefined && requested !== definitionId) {
      setDefinitionId(requested);
      setPreview(null);
    }
  };
  const locked = intent !== null;
  const starting = status.kind === "starting";
  const blocked =
    offline ||
    !permissions.start ||
    starting ||
    (intent === null && (preview === null || !preview.runnable));
  const picked =
    entries?.find((entry) => entry.definitionId === definitionId) ??
    (chosen?.definitionId === definitionId ? chosen : null);
  const options = [
    ...(picked !== null && !entries?.includes(picked) ? [picked] : []),
    ...(entries ?? []),
  ].map((entry) => ({
    value: entry.definitionId!,
    label: entryLabel(entry),
    detail: entry.runnable ? `Revision ${entry.revision}` : "Needs attention",
  }));
  const where =
    preview === null
      ? null
      : workspace === "new-worktree"
        ? `From ${preview.workspace.branch ?? "the current commit"}${preview.workspace.head ? ` at ${short(preview.workspace.head)}` : ""}`
        : `Works in ${preview.workspace.path}${preview.workspace.branch ? ` on ${preview.workspace.branch}` : ""} with its local changes`;
  const footer = (
    <>
      {locked && !starting ? (
        <Button variant="ghost" onClick={discard}>
          Discard pending request
        </Button>
      ) : null}
      <Button variant="ghost" disabled={starting} onClick={onClose}>
        Cancel
      </Button>
      <Button disabled={blocked} onClick={run}>
        {starting ? "Starting…" : locked ? "Retry start request" : "Run workflow"}
      </Button>
    </>
  );
  return (
    <props.Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) onClose();
      }}
      title="Run workflow"
      description={`${projectTitle} · ${props.environmentLabel}`}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="wf-start-workflow" className="text-xs font-medium text-muted-foreground">
            Workflow
          </label>
          {locked ? (
            <p className="text-sm">{preview?.title ?? intent.definitionId}</p>
          ) : (
            <Combobox
              id="wf-start-workflow"
              ariaLabel="Workflow"
              disabled={entries === null && picked === null}
              value={definitionId ?? ""}
              onChange={(value) => {
                setChosen(entries?.find((entry) => entry.definitionId === value) ?? null);
                setDefinitionId(value);
                setPreview(null);
                setStatus({ kind: "idle" });
              }}
              options={options}
              placeholder={
                definitionId ?? (entries === null ? "Loading workflows…" : "Choose a workflow")
              }
              searchPlaceholder="Search workflows"
              emptyText={search.trim() ? "No matching workflows" : "No saved workflows yet"}
              query={query}
              onQueryChange={setQuery}
            />
          )}
        </div>
        {entriesError === null ? null : (
          <Alert
            variant="error"
            title="Could not load workflows"
            actions={
              <Button
                size="xs"
                variant="outline"
                onClick={() => setEntriesAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            }
          >
            {entriesError}
          </Alert>
        )}
        {definitionId === null ? null : previewError !== null ? (
          <Alert
            variant="error"
            title="Could not load this workflow"
            actions={
              <Button
                size="xs"
                variant="outline"
                onClick={() => setPreviewAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            }
          >
            {previewError}
          </Alert>
        ) : preview === null ? (
          offline ? null : (
            <p role="status" className="text-xs text-muted-foreground">
              Loading the saved workflow…
            </p>
          )
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant="outline">Saved revision {preview.revision}</Badge>
              {intent !== null && intent.revision !== preview.revision ? (
                <Badge variant="warning">Requested revision {intent.revision}</Badge>
              ) : null}
              {preview.packaged ? <Badge variant="secondary">Packaged</Badge> : null}
              {preview.runnable ? null : <Badge variant="warning">Cannot run</Badge>}
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {preview.source}
              </span>
            </div>
            {preview.reasons.length === 0 ? null : (
              <Alert variant="error" title="This workflow cannot run">
                <ul aria-label="Why this workflow cannot run" className="flex flex-col gap-0.5">
                  {preview.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {preview.agents.length === 0 ? null : (
              <ul aria-label="Agents" className="flex flex-col gap-1 text-xs">
                {preview.agents.map((agent) => (
                  <li
                    key={`${agent.nodeId}:${agent.branchId ?? ""}`}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">
                      {agent.title}: {agent.providerName ?? agent.providerInstanceId} ·{" "}
                      {agent.model} · {agent.runtimeMode}
                      {agent.interactionMode === "plan" ? " · plan mode" : ""}
                      {agent.skill ? ` · skill ${agent.skill}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Workspace</span>
              {locked ? (
                <p className="text-sm">
                  {workspace === "new-worktree" ? "New worktree" : "Current checkout"}
                </p>
              ) : (
                <div>
                  <SegmentedControl
                    ariaLabel="Workspace"
                    value={workspace}
                    onChange={(value) => setWorkspace(value as Intent["workspace"])}
                    options={[
                      { value: "new-worktree", label: "New worktree" },
                      { value: "current", label: "Current checkout" },
                    ]}
                  />
                </div>
              )}
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {workspace === "new-worktree" ? (
                  <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">{where}</span>
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label
                  htmlFor="wf-start-task"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Task
                </label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {task.length}/{taskLimit}
                </span>
              </div>
              <Textarea
                id="wf-start-task"
                ariaLabel="Task"
                rows={4}
                readOnly={locked}
                value={task}
                onChange={(value) => setTask(value.slice(0, taskLimit))}
                placeholder="Optional · what this run should accomplish"
              />
            </div>
          </>
        )}
        {other && intent !== null ? (
          <Alert
            variant="warning"
            title={`Unconfirmed start of ${intent.definitionId} (revision ${intent.revision})`}
          >
            Retry opens its run if it started; discard it to start {requested}.
          </Alert>
        ) : null}
        {!permissions.start ? (
          <Alert variant="info" title="This connection cannot start workflows." />
        ) : offline ? (
          <p role="status" className="text-xs text-muted-foreground">
            Starting waits until this environment reconnects.
          </p>
        ) : null}
        {status.kind === "failed" ? (
          <Alert variant="error" title="The start request did not complete">
            {status.message} Retry sends the same request.
          </Alert>
        ) : status.kind === "rejected" ? (
          <Alert variant="error" title="The workflow was not started">
            {status.message}
          </Alert>
        ) : null}
      </div>
    </props.Dialog>
  );
}
