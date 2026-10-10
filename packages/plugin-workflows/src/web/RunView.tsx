import type { PluginBreadcrumbItem } from "@t3tools/plugin-host-contract/web";
import type { ProjectId } from "@t3tools/plugin-host-contract/schema";
import {
  ChevronLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CopyIcon,
  CornerDownRightIcon,
  RepeatIcon,
  TriangleAlertIcon,
  XIcon,
  MessageSquareIcon,
  PanelRightIcon,
  RotateCcwIcon,
  StepForwardIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Attempt, Run, WorkflowPermissions } from "../contracts.ts";
import { errorMessage, rejected, useNarrow, type PageProps } from "./common.tsx";
import { RouteList, stepButtonId } from "./Flow.tsx";
import { Graph, type RunOverlay } from "./Graph.tsx";
import { KindIcon, StatusIcon } from "./kinds.tsx";
import { readsAs } from "./decisions.ts";
import { sourceFields } from "../definition.ts";
import {
  attentionLabels,
  attemptTitle,
  clockTime,
  formatTime,
  joinCounts,
  joinStatus,
  requestKind,
  stopText,
  isActive,
  relativeTime,
  sourceShort,
  workspaceShort,
  nextAction,
  nodeTitle,
  phaseLabels,
  phaseStatus,
  repeatEvidence,
  reportStatus,
  routeLabel,
  runStateLabels,
  runStateVariant,
  short,
  sourceText,
  stepStates,
  takenEdges,
  withheldNotice,
  workspaceText,
} from "./run.ts";

type Action = Run["allowedActions"][number];
const actionLabels: Record<Action, string> = {
  cancel: "Cancel run",
  retry: "Retry with a new attempt",
  resume: "Resume retained session",
  approve: "Approve",
  "request-changes": "Request changes",
};
/** One submitted command; its identity and expected revision survive retries of the request. */
interface Pending {
  readonly action: Action;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly inFlight: boolean;
  readonly message: string | null;
}
interface Notice {
  readonly variant: "info" | "warning" | "error";
  readonly title: string;
  readonly detail: string | null;
}
const commandId = (action: Action) =>
  `${action}-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
const HISTORY_PAGE = 50;

type View = "graph" | "routes" | "steps";
/** React Flow needs layout measurement; without it (server rendering, tests) Routes is shown. */
const canvasSupported = () => typeof ResizeObserver !== "undefined";

/** One run, live from the server: its graph, visits, evidence and allowed actions. */
export function RunView({
  props,
  projectId,
  runId,
  permissions,
  breadcrumb,
  runWorkflow,
  projectsAlert,
}: {
  readonly props: PageProps;
  readonly projectId: ProjectId;
  readonly runId: string;
  readonly permissions: WorkflowPermissions;
  readonly breadcrumb: (title: string) => ReadonlyArray<PluginBreadcrumbItem>;
  readonly runWorkflow: ReactNode;
  readonly projectsAlert: ReactNode;
}) {
  const { client, connection, pageState, Button, Badge, Alert, PageHeader, SegmentedControl } =
    props;
  const offline = connection === "disconnected";
  const narrow = useNarrow();
  // Undefined follows the newest visits (or the page of `locate`); a number pins a page.
  const [historyOffset, setHistoryOffset] = useState<number | undefined>(undefined);
  // A deep-linked visit opens the history page that contains it.
  const [locate, setLocate] = useState<string | undefined>(pageState.attempt);
  const [traceOffset, setTraceOffset] = useState<number | undefined>(undefined);
  const [run, setRun] = useState<Run | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [view, setView] = useState<View>(() => (canvasSupported() ? "graph" : "routes"));
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // View-scoped: this subscription follows only this run and closes when the view leaves.
  useEffect(() => {
    if (offline) return;
    setLoadError(null);
    return client.watchRun(
      {
        projectId,
        runId,
        ...(historyOffset !== undefined
          ? { historyOffset }
          : locate !== undefined
            ? { attemptId: locate }
            : {}),
        ...(traceOffset === undefined ? {} : { traceOffset }),
      },
      (value) => {
        setLoadError(null);
        setRun(value);
      },
      setLoadError,
    );
  }, [client, projectId, runId, historyOffset, locate, traceOffset, offline, subscription]);
  // "View route" from a thread focuses that step's box once it exists: the graph reports it
  // after its boxes are measured; the list views focus it once rendered.
  const [routeFocus, setRouteFocus] = useState<string | null>(() =>
    pageState.focus === "route" ? (pageState.node ?? null) : null,
  );
  const routeFocused = useCallback(() => setRouteFocus(null), []);
  useEffect(() => {
    if (run === null || routeFocus === null || view === "graph") return;
    const box =
      typeof document === "undefined" ? null : document.getElementById(stepButtonId(routeFocus));
    if (box === null) return;
    box.focus();
    setRouteFocus(null);
  }, [run, routeFocus, view]);
  const overlay = useMemo<RunOverlay | null>(() => {
    if (run === null) return null;
    const history = run.history;
    // Visits and routing are paged; a partial page cannot say a step was never visited.
    const complete =
      history === undefined ||
      (history.offset === 0 &&
        history.tail &&
        (history.traceOffset ?? 0) === 0 &&
        history.traceTail !== false);
    return {
      steps: stepStates(run),
      taken: takenEdges(run.definition, [...(run.relatedTrace ?? []), ...run.trace]),
      current: run.state === "running" || run.state === "awaiting-review" ? run.currentNode : null,
      complete,
      unseen: complete ? "Not visited" : "Not on this history page",
    };
  }, [run]);

  if (run === null || overlay === null)
    return (
      <>
        <PageHeader breadcrumb={breadcrumb("Run")}>{runWorkflow}</PageHeader>
        <div className="flex flex-col gap-3 p-4">
          {projectsAlert}
          {loadError !== null ? (
            <Alert
              variant="error"
              title="Could not load this run"
              actions={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setSubscription((value) => value + 1)}
                >
                  Retry
                </Button>
              }
            >
              {loadError}
            </Alert>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {offline ? "This run loads after reconnecting." : "Loading run…"}
            </p>
          )}
        </div>
      </>
    );

  const definition = run.definition;
  // A named visit is shown only when it is on this page; it never falls back to another visit.
  const selectedAttempt =
    pageState.attempt !== undefined
      ? run.attempts.find((attempt) => attempt.id === pageState.attempt)
      : pageState.node === undefined
        ? undefined
        : run.attempts.findLast(
            (attempt) =>
              attempt.nodeId === pageState.node &&
              (pageState.branch === undefined || attempt.branchId === pageState.branch),
          );
  const elsewhere = pageState.attempt !== undefined && selectedAttempt === undefined;
  const selectedNode = selectedAttempt?.nodeId ?? pageState.node ?? null;
  const selectedBranch = selectedAttempt?.branchId ?? pageState.branch ?? null;
  const selectedBox =
    selectedNode === null
      ? null
      : selectedBranch === null
        ? selectedNode
        : `${selectedNode}/${selectedBranch}`;
  // The view keeps its last snapshot after the subscription fails, but marks it stale.
  const stale = loadError !== null;
  const select = (state: { node: string; attempt?: string; branch?: string | null } | null) => {
    props.navigate(
      {
        pageId: "workflows.runs",
        projectId,
        state:
          state === null
            ? { run: run.id }
            : {
                run: run.id,
                node: state.node,
                ...(state.attempt === undefined ? {} : { attempt: state.attempt }),
                ...(state.branch == null ? {} : { branch: state.branch }),
              },
      },
      { replace: true },
    );
    if (narrow && state !== null) setInspectorOpen(true);
  };
  // Totals come from the server's complete snapshot, not from the loaded history page.
  const overview = run.overview;
  const firstVisit = run.history?.offset ?? 0;
  const recovery = run.recovery;
  const gateNode = run.gate ? definition.nodes.find((node) => node.id === run.gate!.nodeId) : null;
  const gateReview = run.gate?.reviewId
    ? run.reviews.find((review) => review.id === run.gate!.reviewId)
    : undefined;
  // A retry at a parallel group is the review rerun: a new generation on a verified head.
  const rerunFork = recovery?.retryNodeId
    ? definition.nodes.find((node) => node.id === recovery.retryNodeId && node.kind === "parallel")
    : undefined;
  const label = (action: Action) =>
    action === "retry" && rerunFork ? "Rerun review" : actionLabels[action];
  const allowed = (action: Action) =>
    run.allowedActions.includes(action) &&
    (action === "approve" || action === "request-changes" ? permissions.gate : permissions[action]);
  const busy = pending?.inFlight === true;
  const send = (action: Action) => {
    const command: Pending =
      pending?.action === action
        ? { ...pending, inFlight: true, message: null }
        : {
            action,
            clientRequestId: commandId(action),
            // Gate decisions are bound to the displayed gate revision.
            expectedRevision:
              (action === "approve" || action === "request-changes") && run.gate
                ? run.gate.revision
                : run.revision,
            inFlight: true,
            message: null,
          };
    setPending(command);
    setNotice(null);
    const input = {
      projectId,
      runId: run.id,
      clientRequestId: command.clientRequestId,
      expectedRevision: command.expectedRevision,
    };
    const request =
      action === "approve" || action === "request-changes"
        ? client.gate({ ...input, decision: action })
        : client[action](input);
    request.then(
      (result) => {
        // The view's subscription delivers the committed state; the result only explains it.
        setPending(null);
        // A decision the server could not apply stays until dismissed; success is transient.
        if ((action === "approve" || action === "request-changes") && result.state === "unresolved")
          setNotice({
            variant: "warning",
            title: "Decision not applied",
            detail: result.reason ?? "The reviewed input could not be verified.",
          });
        else props.toast({ title: `${label(action)} applied` });
      },
      (cause: unknown) => {
        if (
          rejected(cause, action === "approve" || action === "request-changes" ? "gate" : action)
        ) {
          // The server refused it; refresh to the current state and decide again.
          setPending(null);
          setNotice({
            variant: "warning",
            title: `${label(action)} not applied`,
            detail: `${errorMessage(cause)} The current run state is shown.`,
          });
          setSubscription((value) => value + 1);
        } else
          setPending({
            ...command,
            inFlight: false,
            message: errorMessage(cause),
          });
      },
    );
  };
  const actionButton = (
    action: Action,
    variant: "default" | "outline" | "ghost",
    icon?: ReactNode,
    size: "xs" | "sm" = "xs",
  ) =>
    allowed(action) ? (
      <Button
        key={action}
        variant={variant}
        size={size}
        disabled={offline || stale || busy || (pending !== null && pending.action !== action)}
        onClick={() => send(action)}
      >
        {icon}
        {pending?.action === action && !pending.inFlight
          ? `Retry: ${label(action)}`
          : label(action)}
      </Button>
    ) : null;
  const active = overview?.activeAttempts ?? [];
  const resumeAttempt = recovery?.resumeAttemptId
    ? run.attempts.find((attempt) => attempt.id === recovery.resumeAttemptId)
    : undefined;
  const recoverable = allowed("resume") || allowed("retry");
  const stopped = run.state === "unresolved" ? (run.stop?.kind ?? null) : null;
  const decisionShown =
    run.gate !== null &&
    gateNode !== null &&
    gateNode !== undefined &&
    (allowed("approve") || allowed("request-changes") || (run.withheld ?? []).length > 0);
  const limit = definition.maxVisits ?? 100;
  const next = nextAction(run, active);
  const alerts = [
    projectsAlert,
    stale && !offline ? (
      <Alert
        key="stale"
        variant="warning"
        title="Not updating"
        actions={
          <Button size="xs" variant="outline" onClick={() => setSubscription((value) => value + 1)}>
            Retry
          </Button>
        }
      >
        {loadError} Actions wait until the run reloads.
      </Alert>
    ) : null,
    decisionShown ? (
      <Alert
        key="gate"
        variant="info"
        title="Needs your decision"
        actions={
          <>
            {actionButton("request-changes", "outline")}
            {actionButton("approve", "default")}
          </>
        }
      >
        <span className="flex flex-col gap-0.5">
          <span>
            {gateNode.title}
            {gateReview ? ` · reviewed head ${short(gateReview.head)}` : ""}
          </span>
          {/* A decision the server withholds stays visible as the reason it is not offered. */}
          {(run.withheld ?? []).map((item) => {
            const notice = withheldNotice(definition, item);
            return (
              <span key={item.action} className="text-muted-foreground">
                {notice.title} · {notice.detail}
              </span>
            );
          })}
        </span>
      </Alert>
    ) : null,
    recoverable ? (
      <Alert
        key="recovery"
        variant="warning"
        title={stopped ? attentionLabels[stopped] : runStateLabels[run.state]}
        actions={
          <>
            {actionButton("retry", "outline", <RotateCcwIcon />)}
            {actionButton("resume", "default", <StepForwardIcon />)}
          </>
        }
      >
        <span className="flex flex-col gap-0.5">
          {stopped ? <span>{stopText(stopped)}</span> : null}
          {run.reason === null ? null : <span>{run.reason}</span>}
          {allowed("resume") ? (
            <span>
              Resume:{" "}
              {resumeAttempt
                ? attemptTitle(definition, resumeAttempt)
                : nodeTitle(definition, run.currentNode)}
              {recovery?.resumeAttemptId ? ` · attempt ${short(recovery.resumeAttemptId)}` : ""}
            </span>
          ) : null}
          {allowed("retry") && rerunFork ? (
            <span>
              Rerun: generation{" "}
              {(run.reviews.findLast((review) => review.fork === rerunFork.id)?.generation ?? 0) +
                1}{" "}
              of {rerunFork.title} · current head, new reviewer worktrees
            </span>
          ) : allowed("retry") && recovery?.retryNodeId ? (
            <span>Retry: new attempt of {nodeTitle(definition, recovery.retryNodeId)}</span>
          ) : null}
        </span>
      </Alert>
    ) : run.reason === null && !stopped ? null : (
      <Alert key="reason" variant="warning" title={stopped ? attentionLabels[stopped] : "Reason"}>
        <span className="flex flex-col gap-0.5">
          {stopped ? <span>{stopText(stopped)}</span> : null}
          {run.reason === null ? null : <span>{run.reason}</span>}
        </span>
      </Alert>
    ),
    run.allowedActions.length > 0 && !run.allowedActions.some((action) => allowed(action)) ? (
      <Alert key="permission" variant="info" title="This connection cannot change workflow runs." />
    ) : null,
    pending?.message ? (
      <Alert
        key="pending"
        variant="error"
        title={`${label(pending.action)} did not complete`}
        actions={
          <Button size="xs" variant="ghost" onClick={() => setPending(null)}>
            Dismiss
          </Button>
        }
      >
        {pending.message} Retry sends the same request.
      </Alert>
    ) : null,
    notice === null ? null : (
      <Alert
        key="notice"
        variant={notice.variant}
        title={notice.title}
        actions={
          <Button size="xs" variant="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        }
      >
        {notice.detail}
      </Alert>
    ),
  ].filter((alert) => alert !== null && alert !== undefined && alert !== false);
  const history = run.history;
  const paged = history !== undefined && history.attempts > history.limit;
  const steps = (
    <ol aria-label="Run steps" className="flex flex-col gap-px">
      {run.attempts.map((attempt, index) => (
        <li key={attempt.id} className="flex min-w-0 items-center gap-1.5 py-0.5">
          <span className="flex size-6 shrink-0 items-center justify-center">
            <StatusIcon status={phaseStatus(attempt.phase)} />
          </span>
          <Button
            size="sm"
            variant={selectedAttempt?.id === attempt.id ? "outline" : "ghost"}
            ariaPressed={selectedAttempt?.id === attempt.id}
            ariaLabel={`Visit ${firstVisit + index + 1}: ${attemptTitle(definition, attempt)}, ${phaseLabels[attempt.phase]}`}
            onClick={() =>
              select({ node: attempt.nodeId, attempt: attempt.id, branch: attempt.branchId })
            }
          >
            <span className="tabular-nums text-muted-foreground">{firstVisit + index + 1}</span>
            {attemptTitle(definition, attempt)}
          </Button>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {phaseLabels[attempt.phase]}
            {attempt.report ? " · report accepted" : ""}
            {attempt.generation > 1 ? ` · generation ${attempt.generation}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
  const inspector = (
    <Inspector
      props={props}
      run={run}
      projectId={projectId}
      nodeId={selectedNode}
      box={selectedBox}
      attempt={selectedAttempt ?? null}
      overlay={overlay}
      firstVisit={firstVisit}
      onSelectAttempt={(attempt) =>
        select({ node: attempt.nodeId, attempt: attempt.id, branch: attempt.branchId })
      }
      onTraceOffset={setTraceOffset}
      onSelectReviewer={(attemptId, branchId) =>
        select({ node: overview!.review!.fork, attempt: attemptId, branch: branchId })
      }
      elsewhere={
        elsewhere ? (
          <Alert
            variant="info"
            title="Visit on another history page"
            actions={
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setHistoryOffset(undefined);
                  setLocate(pageState.attempt);
                  setSubscription((value) => value + 1);
                }}
              >
                Show this visit
              </Button>
            }
          />
        ) : null
      }
    />
  );
  const views = [
    ...(canvasSupported() ? [{ value: "graph", label: "Graph" }] : []),
    { value: "routes", label: "Routes" },
    { value: "steps", label: "Steps" },
  ];
  return (
    <>
      <PageHeader breadcrumb={breadcrumb(definition.title)}>
        <span role="status" aria-live="polite" className="flex items-center gap-1.5">
          <Badge variant={runStateVariant(run.state)}>{runStateLabels[run.state]}</Badge>
          {offline ? <Badge variant="warning">Last loaded state</Badge> : null}
          {stale && !offline ? <Badge variant="warning">Not updating</Badge> : null}
        </span>
        {actionButton("cancel", "ghost", <CircleStopIcon />, "sm")}
        {runWorkflow}
      </PageHeader>
      <dl
        aria-label="Run overview"
        className="flex shrink-0 items-baseline gap-x-5 overflow-hidden border-b border-border px-(--workspace-gutter-start) py-2 text-xs"
      >
        <Fact props={props} label="Started" detail={formatTime(run.createdAt)}>
          {relativeTime(run.createdAt)}
        </Fact>
        <Fact props={props} label="Source" detail={sourceText(run.source)}>
          {sourceShort(run.source)}
        </Fact>
        <Fact
          props={props}
          label="Revision"
          detail={`${definition.id} · revision ${definition.revision}`}
        >
          {String(definition.revision)}
        </Fact>
        <Fact props={props} label="Workspace" detail={workspaceText(run)}>
          {workspaceShort(run)}
        </Fact>
        {overview === undefined ? null : (
          <Fact props={props} label="Progress">
            {[
              // The same server visit count the run list shows.
              `${run.visits} ${run.visits === 1 ? "visit" : "visits"}`,
              // The whole-run visit bound only matters once it is close.
              run.visits >= limit * 0.8 ? `${run.visits}/${limit} allowed` : null,
              overview.review
                ? `reviews ${overview.review.reported}/${overview.review.required} reported, ${overview.review.settled}/${overview.review.required} settled`
                : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </Fact>
        )}
        {active.length === 0 ? null : (
          <Fact props={props} label="Active attempts">
            {active
              .map(
                (attempt) => `${attemptTitle(definition, attempt)} (${phaseLabels[attempt.phase]})`,
              )
              .join(", ")}
          </Fact>
        )}
        {decisionShown || recoverable || next === null ? null : (
          <Fact props={props} label="Next">
            {next}
          </Fact>
        )}
      </dl>
      {alerts.length === 0 && !(offline && run.allowedActions.length > 0) && !busy ? null : (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3">
          {alerts}
          {offline && run.allowedActions.length > 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              Actions wait until this environment reconnects.
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-xs text-muted-foreground">
              Sending {label(pending.action).toLowerCase()}…
            </p>
          ) : null}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <section aria-label="Run" className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            <SegmentedControl
              ariaLabel="Run view"
              value={view}
              options={views}
              onChange={(value) => setView(value as View)}
            />
            {paged ? (
              <nav aria-label="Run history pages" className="flex items-center gap-0.5 text-xs">
                <span role="status" className="mr-1 tabular-nums text-muted-foreground">
                  {history.tail ? "Newest visits: " : "Earlier visits: "}
                  {firstVisit + 1}–{firstVisit + run.attempts.length} of {history.attempts}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel="Earlier"
                  tooltip="Earlier visits"
                  disabled={firstVisit === 0}
                  onClick={() => setHistoryOffset(Math.max(0, firstVisit - HISTORY_PAGE))}
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel="Later"
                  tooltip="Later visits"
                  disabled={history.tail}
                  onClick={() => {
                    setLocate(undefined);
                    setHistoryOffset(
                      firstVisit + 2 * HISTORY_PAGE >= history.attempts
                        ? undefined
                        : firstVisit + HISTORY_PAGE,
                    );
                  }}
                >
                  <ChevronRightIcon />
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={history.tail}
                  onClick={() => {
                    setLocate(undefined);
                    setHistoryOffset(undefined);
                  }}
                >
                  Newest
                </Button>
              </nav>
            ) : null}
            {narrow ? (
              <span className="ml-auto">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel="Evidence"
                  tooltip="Evidence"
                  onClick={() => setInspectorOpen(true)}
                >
                  <PanelRightIcon />
                </Button>
              </span>
            ) : null}
          </div>
          {view === "graph" ? (
            <div className="relative min-h-0 flex-1">
              <Graph
                Tooltip={props.Tooltip}
                definition={definition}
                selected={selectedBox}
                problems={[]}
                readOnly
                run={overlay}
                focus={routeFocus}
                onFocused={routeFocused}
                onSelect={(stepId, boxId) =>
                  select(
                    stepId === null
                      ? null
                      : {
                          node: stepId,
                          branch:
                            boxId !== undefined && boxId.startsWith(`${stepId}/`)
                              ? boxId.slice(stepId.length + 1)
                              : null,
                        },
                  )
                }
              />
            </div>
          ) : view === "routes" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <RouteList
                props={props}
                definition={definition}
                selected={selectedNode}
                problems={[]}
                readOnly
                onSelect={(id) => select(selectedNode === id ? null : { node: id })}
                onMove={() => {}}
                onRemove={() => {}}
                renderStatus={(node) => {
                  const state = overlay.steps.get(node.id);
                  return (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <StatusIcon status={state?.status ?? "pending"} className="size-3.5" />
                      <span className="truncate">
                        {state?.label ?? overlay.unseen}
                        {overlay.complete && state && state.visits > 1
                          ? ` · ${state.visits} visits`
                          : ""}
                      </span>
                    </span>
                  );
                }}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {run.attempts.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">No step visited yet</p>
              ) : (
                steps
              )}
            </div>
          )}
        </section>
        {narrow ? null : (
          <aside
            aria-labelledby="wf-evidence-title"
            className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card/40 p-4"
          >
            {inspector}
          </aside>
        )}
      </div>
      {narrow ? (
        <props.Sheet open={inspectorOpen} onOpenChange={setInspectorOpen} title="Evidence">
          {inspector}
        </props.Sheet>
      ) : null}
    </>
  );
}

/** One overview fact on a single line; `detail` is the full value, on hover. */
function Fact({
  props,
  label,
  detail,
  children,
}: {
  readonly props: PageProps;
  readonly label: string;
  readonly detail?: string;
  readonly children: string;
}) {
  return (
    <div className="flex min-w-0 shrink items-baseline gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 truncate">
        {detail === undefined ? (
          children
        ) : (
          <props.Tooltip content={detail}>{children}</props.Tooltip>
        )}
      </dd>
    </div>
  );
}

/**
 * The right panel: route history for the whole run, or the selected step's visits with the
 * selected visit's evidence. Accepted claims, check output and routing stay separate.
 */
function Inspector({
  props,
  run,
  projectId,
  nodeId,
  box,
  attempt,
  overlay,
  firstVisit,
  onSelectAttempt,
  onTraceOffset,
  onSelectReviewer,
  elsewhere,
}: {
  readonly props: PageProps;
  readonly run: Run;
  readonly projectId: ProjectId;
  readonly nodeId: string | null;
  readonly box: string | null;
  readonly attempt: Attempt | null;
  readonly overlay: RunOverlay;
  readonly firstVisit: number;
  readonly onSelectAttempt: (attempt: Attempt) => void;
  readonly onTraceOffset: (offset: number | undefined) => void;
  readonly onSelectReviewer: (attemptId: string, branchId: string) => void;
  readonly elsewhere: ReactNode;
}) {
  const { Button, Badge } = props;
  const definition = run.definition;
  const node = nodeId === null ? undefined : definition.nodes.find((item) => item.id === nodeId);
  const review = run.overview?.review ?? null;
  const reviewSummary =
    review === null ? null : (
      <ReviewSummary
        props={props}
        run={run}
        projectId={projectId}
        review={review}
        selected={attempt?.id ?? null}
        onSelect={onSelectReviewer}
      />
    );
  if (elsewhere)
    return (
      <section className="flex flex-col gap-3">
        <h2 id="wf-evidence-title" className="text-sm font-medium">
          Evidence
        </h2>
        {elsewhere}
      </section>
    );
  if (nodeId === null) {
    const history = run.history;
    const traceStart = history?.traceOffset ?? 0;
    return (
      <section className="flex flex-col gap-3">
        {reviewSummary}
        <h2 id="wf-evidence-title" className="text-sm font-medium">
          Route history
        </h2>
        {history !== undefined && history.trace > history.limit ? (
          <nav aria-label="Route history pages" className="flex items-center gap-0.5 text-xs">
            <span role="status" className="mr-1 tabular-nums text-muted-foreground">
              {traceStart + 1}–{traceStart + run.trace.length} of {history.trace}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              ariaLabel="Earlier routes"
              tooltip="Earlier routes"
              disabled={traceStart === 0}
              onClick={() => onTraceOffset(Math.max(0, traceStart - HISTORY_PAGE))}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              ariaLabel="Later routes"
              tooltip="Later routes"
              disabled={history.traceTail !== false}
              onClick={() =>
                onTraceOffset(
                  traceStart + 2 * HISTORY_PAGE >= history.trace
                    ? undefined
                    : traceStart + HISTORY_PAGE,
                )
              }
            >
              <ChevronRightIcon />
            </Button>
          </nav>
        ) : null}
        {run.trace.length === 0 ? (
          <p className="text-xs text-muted-foreground">No route taken yet</p>
        ) : (
          <ol aria-label="Route history" className="flex flex-col gap-1 text-xs">
            {run.trace.map((item) => (
              <RouteRow key={item.id} props={props} definition={definition} item={item} />
            ))}
          </ol>
        )}
      </section>
    );
  }
  const state = box === null ? undefined : overlay.steps.get(box);
  const lane =
    node?.kind === "parallel" && box !== null && box.startsWith(`${node.id}/`)
      ? node.branches.find((branch) => branch.id === box.slice(node.id.length + 1))
      : undefined;
  // Visits of the selected box on the loaded history page, numbered per step; the run-wide
  // visit number stays as secondary context.
  const visits = run.attempts.flatMap((item, index) =>
    item.nodeId === nodeId && (lane === undefined || item.branchId === lane.id)
      ? [{ attempt: item, overall: firstVisit + index + 1 }]
      : [],
  );
  // Only agent steps and reviewer lanes run in native threads.
  const threaded = node?.kind === "agent" || node?.kind === "parallel";
  // Routing records that consumed this visit come with its page even when route history is
  // paged elsewhere; node-level records come from the loaded route-history page.
  const related = attempt
    ? new Set([attempt.id, `${attempt.id}:report`, ...(attempt.reviewId ? [attempt.reviewId] : [])])
    : null;
  const routing = [...(run.relatedTrace ?? []), ...run.trace]
    .filter((item) =>
      related
        ? (item.attemptId !== null && related.has(item.attemptId)) ||
          item.sourceIds.some((id) => related.has(id))
        : item.nodeId === nodeId,
    )
    .toSorted((left, right) => left.at - right.at);
  const inputs = [...new Set(routing.flatMap((item) => item.sourceIds))];
  // Per-step numbers are only true when the page starts at the run's first visit.
  const perStep = firstVisit === 0;
  return (
    <section className="flex min-w-0 flex-col gap-4 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="wf-evidence-title" className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {node === undefined ? null : (
            <KindIcon kind={lane ? "branch" : node.kind} className="size-4 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">
            {attempt
              ? attemptTitle(definition, attempt)
              : lane
                ? `${node?.title} · ${lane.title}`
                : nodeTitle(definition, nodeId)}
          </span>
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusIcon status={state?.status ?? "pending"} className="size-3.5" />
          {state?.label ?? overlay.unseen}
          {state && state.visits > 0
            ? ` · ${state.visits} ${state.visits === 1 ? "visit" : "visits"}${overlay.complete ? "" : " on this page"}`
            : ""}
        </span>
      </div>
      {review !== null && node?.id === review.fork && lane === undefined ? reviewSummary : null}
      {visits.length > 1 ? (
        <ol aria-label="Visits" className="flex flex-col gap-px">
          {visits.map(({ attempt: item, overall }, index) => (
            <li key={item.id}>
              <Button
                size="row"
                variant={attempt?.id === item.id ? "outline" : "ghost"}
                ariaPressed={attempt?.id === item.id}
                ariaLabel={`${perStep ? `Visit ${index + 1} of this step` : `Run visit ${overall}`}, ${phaseLabels[item.phase]}`}
                onClick={() => onSelectAttempt(item)}
              >
                <StatusIcon status={phaseStatus(item.phase)} className="size-3.5" />
                <span className="tabular-nums">
                  {perStep ? `Visit ${index + 1}` : `Run visit ${overall}`}
                </span>
                <span className="text-muted-foreground">{phaseLabels[item.phase]}</span>
                {perStep ? (
                  <span className="ml-auto tabular-nums text-muted-foreground">#{overall}</span>
                ) : null}
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {attempt === null ? (
        visits.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {node?.kind === "decision" || node?.kind === "join" || node?.kind === "human"
              ? "Routing step · no agent visit"
              : "No visit on this history page"}
          </p>
        ) : null
      ) : (
        <>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Execution</dt>
            <dd className="flex items-center gap-1">
              <StatusIcon status={phaseStatus(attempt.phase)} className="size-3.5" />
              {phaseLabels[attempt.phase]}
              {attempt.generation > 1 ? ` · generation ${attempt.generation}` : ""}
              {attempt.resumeCount > 0 ? ` · resumed ${attempt.resumeCount}×` : ""}
            </dd>
            <dt className="text-muted-foreground">Report</dt>
            <dd>{reportStatus(attempt)}</dd>
            {attempt.reason === null ? null : (
              <>
                <dt className="text-muted-foreground">Stop reason</dt>
                <dd className="break-words">{attempt.reason}</dd>
              </>
            )}
            {attempt.deadline === null ? null : (
              <>
                <dt className="text-muted-foreground">Deadline</dt>
                <dd>{formatTime(attempt.deadline)}</dd>
              </>
            )}
            {attempt.skill === null ? null : (
              <>
                <dt className="text-muted-foreground">Skill</dt>
                <dd className="break-words">
                  {attempt.skill.name}
                  {attempt.skill.fingerprint
                    ? ` · ${short(attempt.skill.fingerprint)}`
                    : attempt.skill.limitation
                      ? ` · ${attempt.skill.limitation}`
                      : ""}
                </dd>
              </>
            )}
          </dl>
          {attempt.phase === "waiting-input" && (attempt.requests ?? []).length > 0 ? (
            <section aria-label="Pending native requests" className="flex flex-col gap-1 text-xs">
              <p className="font-medium">Pending requests</p>
              <ol aria-label="Pending native requests" className="flex flex-col gap-0.5">
                {(attempt.requests ?? []).map((request, index, all) => (
                  <li key={request.id} className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">
                      {requestKind(request.kind)} request {index + 1} of{" "}
                      {Math.max(attempt.pendingRequests ?? 0, all.length)}
                    </span>
                    {index === 0 ? <Badge variant="info">Next</Badge> : null}
                    <span className="ml-auto flex shrink-0 tabular-nums text-muted-foreground">
                      <props.Tooltip content={formatTime(request.createdAt)}>
                        {clockTime(request.createdAt)}
                      </props.Tooltip>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {attempt.threadId ? (
            <div>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  props.openThread({
                    environmentId: run.environmentId,
                    projectId,
                    threadId: attempt.threadId!,
                  })
                }
              >
                <MessageSquareIcon />
                Open thread
              </Button>
            </div>
          ) : threaded ? (
            <p className="text-xs text-muted-foreground">No native thread</p>
          ) : null}
          {attempt.report === null ? null : (
            <section
              aria-label="Agent report"
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-xs"
            >
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">Agent report</span>
                <Badge variant="outline">{attempt.report.outcome} claim</Badge>
                <span className="ml-auto text-muted-foreground">
                  {clockTime(attempt.report.receipt.acceptedAt)}
                </span>
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{attempt.report.summary}</p>
              {Object.keys(attempt.report.data).length ? (
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                  {Object.entries(attempt.report.data).map(([name, value]) => (
                    <Pair key={name} name={name} value={String(value)} />
                  ))}
                </dl>
              ) : null}
              {attempt.report.evidence.length ? (
                <ul aria-label="Reported evidence" className="flex flex-col gap-0.5">
                  {attempt.report.evidence.map((item) => (
                    <li key={`${item.kind}:${item.reference}`} className="break-all font-mono">
                      {item.kind}: {item.reference}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          )}
          {attempt.check === null ? null : (
            <section
              aria-label="Check output"
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-xs"
            >
              <p className="flex items-center gap-1.5">
                <span className="text-sm font-medium">Check</span>
                <Badge variant={attempt.check.outcome === "completed" ? "success" : "warning"}>
                  {attempt.check.outcome}
                </Badge>
                <span className="text-muted-foreground">
                  exit {attempt.check.exitCode ?? "none"}
                  {attempt.check.timedOut ? " · timed out" : ""}
                  {attempt.check.interrupted ? " · interrupted" : ""}
                </span>
              </p>
              {attempt.check.stdout ? (
                <pre
                  aria-label="Standard output"
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2"
                >
                  {attempt.check.stdout}
                </pre>
              ) : null}
              {attempt.check.stderr ? (
                <pre
                  aria-label="Standard error"
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2"
                >
                  {attempt.check.stderr}
                </pre>
              ) : null}
            </section>
          )}
          {Object.keys(attempt.input).length ? (
            <section aria-label="Recorded input" className="flex flex-col gap-1 text-xs">
              <p className="font-medium">Recorded input</p>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                {Object.entries(attempt.input).map(([name, value]) => (
                  <Pair key={name} name={name} value={String(value)} />
                ))}
              </dl>
            </section>
          ) : null}
        </>
      )}
      <section aria-label="Routing" className="flex flex-col gap-1.5 text-xs">
        <p className="font-medium">Routing</p>
        {routing.length === 0 ? (
          <p className="text-muted-foreground">
            {attempt
              ? isActive(attempt)
                ? "Not routed yet"
                : "Routing stopped at this visit"
              : "No routing record on this page"}
          </p>
        ) : (
          <ol aria-label="Recorded routing" className="flex flex-col gap-1">
            {routing.map((item) => (
              <RouteRow key={item.id} props={props} definition={definition} item={item} detailed />
            ))}
          </ol>
        )}
      </section>
      {attempt === null ? null : (
        <details className="group text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
            Details
          </summary>
          <dl className="mt-2 flex flex-col gap-1.5">
            <Identifier props={props} label="Attempt" value={attempt.id} />
            {attempt.threadId ? (
              <Identifier props={props} label="Thread" value={attempt.threadId} />
            ) : null}
            {attempt.report ? (
              <Identifier props={props} label="Report receipt" value={attempt.report.receipt.id} />
            ) : null}
            {inputs.map((id) => (
              <Identifier key={id} props={props} label="Routing input" value={id} />
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}

/**
 * A recorded routing decision as one timeline row: the route that fired and any repeat
 * outcome as badges, the server's reason on hover. `detailed` adds the conditions considered.
 */
function RouteRow({
  props,
  definition,
  item,
  detailed = false,
}: {
  readonly props: PageProps;
  readonly definition: Run["definition"];
  readonly item: Run["trace"][number];
  readonly detailed?: boolean;
}) {
  const { Badge, Tooltip } = props;
  // A plain Next route needs no badge; rules, Otherwise and gate decisions do.
  const route = item.route === "next" ? null : routeLabel(item);
  const repeat = repeatEvidence(definition, item);
  const Icon = repeat?.limit
    ? TriangleAlertIcon
    : repeat !== null
      ? RepeatIcon
      : CornerDownRightIcon;
  const from = definition.nodes.find((node) => node.id === item.nodeId);
  // Fields of the snapshot the decision read; only used to word the recorded conditions.
  const fields =
    detailed && (from?.kind === "decision" || from?.kind === "join")
      ? sourceFields(
          from.kind === "join" ? from : definition.nodes.find((node) => node.id === from.source),
          definition,
        )
      : null;
  const otherwise = item.route === "otherwise";
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0">
          <Tooltip content={item.reason}>
            {nodeTitle(definition, item.nodeId)} → {nodeTitle(definition, item.chosen)}
          </Tooltip>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-5">
        {route === null ? null : <Badge variant="outline">{route}</Badge>}
        {repeat === null ? null : (
          <span className="flex shrink-0">
            <Tooltip content={repeat.detail}>
              <Badge variant={repeat.limit ? "warning" : "info"}>{repeat.label}</Badge>
            </Tooltip>
          </span>
        )}
        <span className="ml-auto flex shrink-0 tabular-nums text-muted-foreground">
          <Tooltip content={formatTime(item.at)}>{clockTime(item.at)}</Tooltip>
        </span>
      </div>
      {detailed && repeat !== null && item.repeat !== undefined ? (
        <p className="pl-5 text-muted-foreground">{repeat.detail}</p>
      ) : null}
      {detailed && (item.considered.length > 0 || otherwise) ? (
        <ul aria-label="Conditions considered" className="flex flex-col gap-0.5 pl-5">
          {item.considered.map((choice, index) => {
            const text = readsAs(choice.predicate, fields);
            return (
              <li key={index} className="flex min-w-0 items-center gap-1.5">
                {choice.matched ? (
                  <CheckIcon aria-hidden className="size-3 shrink-0 text-success" />
                ) : (
                  <XIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="shrink-0 text-muted-foreground">
                  Rule {index + 1}
                  <span className="sr-only">
                    {choice.matched ? " matched: " : " did not match: "}
                  </span>
                </span>
                <span className="flex min-w-0">
                  <Tooltip content={text}>{text}</Tooltip>
                </span>
              </li>
            );
          })}
          {otherwise ? (
            <li className="flex min-w-0 items-center gap-1.5">
              <CheckIcon aria-hidden className="size-3 shrink-0 text-success" />
              <span className="text-muted-foreground">
                Otherwise
                <span className="sr-only"> taken: no rule matched</span>
              </span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** An internal identifier with a copy action, kept out of the way under Details. */
function Identifier({
  props,
  label,
  value,
}: {
  readonly props: PageProps;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono">{value}</dd>
      <props.Button
        size="icon-xs"
        variant="ghost"
        ariaLabel={`Copy ${label.toLowerCase()}`}
        tooltip="Copy"
        onClick={() => void navigator.clipboard?.writeText(value)}
      >
        <CopyIcon />
      </props.Button>
    </div>
  );
}

function Pair({ name, value }: { readonly name: string; readonly value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="whitespace-pre-wrap break-words">{value}</dd>
    </>
  );
}

type Review = NonNullable<NonNullable<Run["overview"]>["review"]>;
/**
 * The newest review generation: every required reviewer from the server's complete set, its
 * frozen input and isolated checkout, and the join's persisted result. Nothing is counted here.
 */
function ReviewSummary({
  props,
  run,
  projectId,
  review,
  selected,
  onSelect,
}: {
  readonly props: PageProps;
  readonly run: Run;
  readonly projectId: ProjectId;
  readonly review: Review;
  readonly selected: string | null;
  readonly onSelect: (attemptId: string, branchId: string) => void;
}) {
  const { Button, Badge, Tooltip } = props;
  const fork = run.definition.nodes.find((node) => node.id === review.fork);
  const branches = fork?.kind === "parallel" ? fork.branches : [];
  const earlier = run.reviews.filter((item) => item.fork === review.fork && item.id !== review.id);
  const join = joinStatus(review);
  return (
    <section aria-labelledby="wf-review-title" className="flex min-w-0 flex-col gap-2 text-xs">
      <h3 id="wf-review-title" className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <KindIcon kind="parallel" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">
          Parallel review: {fork?.title ?? review.fork} · generation {review.generation}
        </span>
      </h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Frozen head</dt>
        <dd className="flex min-w-0">
          <Tooltip content={`${review.head} · verified when this generation started`}>
            {review.pullRequest.repository}#{review.pullRequest.number} at committed head{" "}
            {short(review.head)}
          </Tooltip>
        </dd>
        <dt className="text-muted-foreground">Join</dt>
        <dd>
          Wait for all · All {review.required} {review.required === 1 ? "reviewer" : "reviewers"}{" "}
          required
        </dd>
        <dt className="text-muted-foreground">Result</dt>
        <dd role="status" className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant={join.variant}>{join.label}</Badge>
          <span className="tabular-nums text-muted-foreground">{joinCounts(review)}</span>
        </dd>
      </dl>
      <ol aria-label="Required reviewers" className="flex flex-col gap-px">
        {review.branches.map((branch) => {
          const authored = branches.find((item) => item.id === branch.id);
          const name = authored?.title ?? branch.id;
          const report = branch.report
            ? `Report accepted (${branch.report.outcome} claim)`
            : isActive(branch)
              ? "No report yet"
              : "No accepted report";
          return (
            <li key={branch.attemptId} className="flex min-w-0 items-center gap-0.5">
              <Button
                size="row"
                variant={selected === branch.attemptId ? "outline" : "ghost"}
                ariaPressed={selected === branch.attemptId}
                ariaLabel={`Show the evidence of reviewer ${name}`}
                tooltip={[
                  authored?.instruction,
                  branch.deadline === null ? null : `Deadline ${formatTime(branch.deadline)}`,
                  branch.workspace
                    ? `Isolated worktree ${branch.workspace.path}${branch.workspace.frozenHead ? ` at ${short(branch.workspace.frozenHead)}` : ""}`
                    : "Isolated worktree not prepared yet",
                  branch.reason === null ? null : `Stop reason: ${branch.reason}`,
                ]
                  .filter((part) => part != null && part !== "")
                  .join("\n")}
                onClick={() => onSelect(branch.attemptId, branch.id)}
              >
                <StatusIcon status={phaseStatus(branch.phase)} className="size-3.5" />
                <span className="truncate">{name}</span>
                <span className="ml-auto truncate text-muted-foreground">
                  {phaseLabels[branch.phase]} · {report}
                </span>
              </Button>
              {branch.threadId ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel={`Open the thread of reviewer ${name}`}
                  tooltip="Open thread"
                  onClick={() =>
                    props.openThread({
                      environmentId: run.environmentId,
                      projectId,
                      threadId: branch.threadId!,
                    })
                  }
                >
                  <MessageSquareIcon />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {earlier.length > 0 ? (
        <ul aria-label="Review generations" className="flex flex-col gap-0.5 text-muted-foreground">
          {earlier.map((item) => (
            <li key={item.id} className="truncate">
              Generation {item.generation} · head {short(item.head)} ·{" "}
              {item.result === null ? "no result" : item.result.replace("_", " ")}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
