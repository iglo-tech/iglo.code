import type { PluginBreadcrumbItem } from "@t3tools/plugin-host-contract/web";
import type { ProjectId } from "@t3tools/plugin-host-contract/schema";
import { FolderIcon, HistoryIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { RunSummary } from "../contracts.ts";
import {
  ProjectsAlert,
  errorMessage,
  projectCrumb,
  usePermissions,
  useProjects,
  type PageProps,
} from "./common.tsx";
import { RunStateIcon } from "./kinds.tsx";
import { RunView } from "./RunView.tsx";
import { StartDialog } from "./Start.tsx";
import { formatTime, nextAction, runStateLabels, runStateVariant } from "./run.ts";

export function RunsPageView(props: PageProps) {
  return <Runs key={`${props.environmentId}:${props.projectId}`} {...props} />;
}

function Runs(props: PageProps) {
  const { projectId, pageState, Button, PageHeader, ListGroup, ListRow, Empty } = props;
  const projects = useProjects(props);
  const permissions = usePermissions(props.client);
  const runId = pageState.run ?? null;
  const library = () =>
    props.navigate(
      projectId === null
        ? { pageId: "workflows.library" }
        : { pageId: "workflows.library", projectId },
    );
  const crumbs: ReadonlyArray<PluginBreadcrumbItem> = [
    projectCrumb(props, projects.projects, "workflows.runs"),
    { label: "Workflows", onSelect: library },
  ];
  const start = (primary: boolean) =>
    projectId === null ? null : (
      <Button
        size="sm"
        variant={primary ? "default" : "ghost"}
        onClick={() =>
          props.navigate({
            pageId: "workflows.runs",
            projectId,
            state: { ...(runId === null ? {} : { run: runId }), start: "1" },
          })
        }
      >
        <PlayIcon />
        Run workflow
      </Button>
    );
  const dialog =
    projectId === null || pageState.start !== "1" ? null : (
      <StartDialog
        // Each entry point's preselection opens a fresh dialog.
        key={pageState.workflow ?? ""}
        props={props}
        projectId={projectId}
        projectTitle={
          projects.projects?.find((project) => project.id === projectId)?.title ?? projectId
        }
        permissions={permissions}
        onClose={() =>
          props.navigate({
            pageId: "workflows.runs",
            projectId,
            ...(runId === null ? {} : { state: { run: runId } }),
          })
        }
      />
    );
  if (projectId !== null && runId !== null)
    return (
      <>
        <RunView
          key={runId}
          props={props}
          projectId={projectId}
          runId={runId}
          permissions={permissions}
          breadcrumb={(title) => [
            ...crumbs,
            {
              label: "Runs",
              onSelect: () => props.navigate({ pageId: "workflows.runs", projectId }),
            },
            { label: title },
          ]}
          runWorkflow={start(false)}
          projectsAlert={
            projects.error === null ? null : <ProjectsAlert props={props} projects={projects} />
          }
        />
        {dialog}
      </>
    );
  return (
    <>
      <PageHeader breadcrumb={[...crumbs, { label: "Runs" }]}>{start(true)}</PageHeader>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 pt-6 pb-12 sm:px-6">
          <ProjectsAlert props={props} projects={projects} />
          {projectId === null ? (
            projects.projects === null ? (
              projects.error === null ? (
                <p role="status" className="px-4 text-sm text-muted-foreground">
                  Loading projects…
                </p>
              ) : null
            ) : projects.projects.length === 0 ? (
              <Empty title="No projects in this environment" icon={<HistoryIcon />} />
            ) : (
              <ListGroup title="Choose a project">
                {projects.projects.map((project) => (
                  <ListRow
                    key={project.id}
                    title={project.title}
                    leading={<FolderIcon />}
                    onOpen={() =>
                      props.navigate({ pageId: "workflows.runs", projectId: project.id })
                    }
                  />
                ))}
              </ListGroup>
            )
          ) : (
            <History
              props={props}
              projectId={projectId}
              onStart={() =>
                props.navigate({ pageId: "workflows.runs", projectId, state: { start: "1" } })
              }
            />
          )}
        </div>
      </div>
      {dialog}
    </>
  );
}

/** Latest runs live, then older pages on request; any run opens its own live view. */
function History({
  props,
  projectId,
  onStart,
}: {
  readonly props: PageProps;
  readonly projectId: ProjectId;
  readonly onStart: () => void;
}) {
  const { client, connection, Button, Badge, Alert, Empty, ListGroup, ListRow } = props;
  const offline = connection === "disconnected";
  const [latest, setLatest] = useState<ReadonlyArray<RunSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [older, setOlder] = useState<ReadonlyArray<RunSummary>>([]);
  const [olderState, setOlderState] = useState<
    | { readonly kind: "idle" | "loading" | "end" }
    | { readonly kind: "failed"; readonly message: string }
  >({ kind: "idle" });
  useEffect(() => {
    if (offline) return;
    setError(null);
    return client.subscribeRuns(
      projectId,
      (runs) => {
        setError(null);
        setLatest((previous) => {
          // Once older pages are shown, runs pushed out of the latest page join them, so the
          // boundary between the live page and loaded older pages never loses a run.
          const dropped = (previous ?? []).filter(
            (run) => !runs.some((item) => item.id === run.id),
          );
          if (dropped.length > 0)
            setOlder((current) =>
              current.length === 0
                ? current
                : [
                    ...dropped,
                    ...current.filter((run) => !dropped.some((item) => item.id === run.id)),
                  ],
            );
          return runs;
        });
      },
      setError,
    );
  }, [client, projectId, offline, attempt]);
  const runs = [
    ...(latest ?? []),
    ...older.filter((run) => !latest?.some((item) => item.id === run.id)),
  ];
  const loadOlder = () => {
    const last = runs.at(-1);
    if (last === undefined) return;
    setOlderState({ kind: "loading" });
    client.runs({ projectId, before: last.id }).then(
      (page) => {
        setOlder((current) => [...current, ...page]);
        setOlderState({ kind: page.length < 20 ? "end" : "idle" });
      },
      (cause: unknown) => setOlderState({ kind: "failed", message: errorMessage(cause) }),
    );
  };
  return (
    <>
      {error === null ? null : (
        <Alert
          variant="error"
          title="Could not load runs"
          actions={
            <Button size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {latest === null ? (
        offline ? (
          <Empty title="Not loaded" description="Runs load after reconnecting." />
        ) : error === null ? (
          <p role="status" className="px-4 text-sm text-muted-foreground">
            Loading runs…
          </p>
        ) : null
      ) : runs.length === 0 ? (
        <Empty title="No runs yet" icon={<HistoryIcon />}>
          <Button size="sm" disabled={offline} onClick={onStart}>
            <PlayIcon />
            Run workflow
          </Button>
        </Empty>
      ) : (
        <ListGroup ariaLabel="Runs">
          {runs.map((run) => {
            const needsYou = run.state === "awaiting-review" || run.state === "unresolved";
            return (
              <ListRow
                key={run.id}
                title={run.definition.title}
                leading={<RunStateIcon state={run.state} />}
                openLabel={`Open run ${run.definition.title} from ${formatTime(run.createdAt)}`}
                onOpen={() =>
                  props.navigate({ pageId: "workflows.runs", projectId, state: { run: run.id } })
                }
                badges={
                  <>
                    <Badge variant={runStateVariant(run.state)}>{runStateLabels[run.state]}</Badge>
                    {run.source?.trigger === "schedule" ? (
                      <Badge variant="secondary">Scheduled</Badge>
                    ) : null}
                  </>
                }
                description={[
                  formatTime(run.createdAt),
                  `Revision ${run.definition.revision}`,
                  `${run.visits} ${run.visits === 1 ? "visit" : "visits"}`,
                  needsYou ? nextAction(run) : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              />
            );
          })}
        </ListGroup>
      )}
      {offline && latest !== null ? (
        <p role="status" className="px-4 text-xs text-muted-foreground">
          Last loaded runs
        </p>
      ) : null}
      {latest !== null && latest.length >= 20 && olderState.kind !== "end" ? (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="ghost"
            disabled={offline || olderState.kind === "loading"}
            onClick={loadOlder}
          >
            {olderState.kind === "loading" ? "Loading older runs…" : "Load older runs"}
          </Button>
        </div>
      ) : null}
      {olderState.kind === "failed" ? (
        <Alert variant="error" title="Could not load older runs">
          {olderState.message}
        </Alert>
      ) : null}
    </>
  );
}
