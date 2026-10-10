import type { PluginBreadcrumbItem } from "@t3tools/plugin-host-contract/web";
import type { ProjectId } from "@t3tools/plugin-host-contract/schema";
import {
  CircleAlertIcon,
  GavelIcon,
  InboxIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { limits, type AttentionItem, type AttentionPage, type AttentionRun } from "../contracts.ts";
import { ProjectsAlert, useProjects, type PageProps } from "./common.tsx";
import {
  attentionLabels,
  attentionText,
  formatTime,
  relativeTime,
  runStateLabels,
  runStateVariant,
} from "./run.ts";

const PAGE = limits.attentionRuns;
/** The server's bound on one attention read. */
const MAX = limits.attentionRunsMax;

export function AttentionPageView(props: PageProps) {
  return <Attention key={`${props.environmentId}:${props.projectId ?? ""}`} {...props} />;
}

/**
 * Runs that need a person, grouped by run, newest first. The server owns every item and its
 * total; viewing, reading or snoozing a thread here or elsewhere clears nothing.
 */
function Attention(props: PageProps) {
  const { client, connection, projectId, Button, Badge, Alert, Empty, PageHeader } = props;
  const offline = connection === "disconnected";
  const projects = useProjects(props);
  const [latest, setLatest] = useState<AttentionPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // How many newest runs to follow. Loading older runs widens the one live read, so every
  // listed run, older ones included, is what the server sent in a single snapshot.
  const [limit, setLimit] = useState<number>(PAGE);
  // The limit of the snapshot on screen; it stays visible until the wider one arrives.
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (offline) return;
    setError(null);
    return client.subscribeAttention(
      { projectId, limit },
      (page) => {
        setError(null);
        setLatest(page);
        setShown(limit);
      },
      setError,
    );
  }, [client, projectId, limit, offline, attempt]);
  const runs = latest?.runs ?? [];
  const live = !offline && error === null;
  const loading = live && latest !== null && shown !== limit;
  // Judged on the list on screen, so the bound is never claimed before the wider read lands.
  const capped = latest !== null && runs.length < latest.total && shown === MAX;
  const projectTitle = (id: string) =>
    projects.projects?.find((project) => project.id === id)?.title ?? id;
  const scope = (id: ProjectId | null) =>
    props.navigate(
      id === null
        ? { pageId: "workflows.attention" }
        : { pageId: "workflows.attention", projectId: id },
    );
  const crumbs: ReadonlyArray<PluginBreadcrumbItem> = [
    {
      label: projectId === null ? "All projects" : projectTitle(projectId),
      ariaLabel: "Project",
      value: projectId ?? "",
      disabled: offline || projects.projects === null,
      options: [
        { value: "", label: "All projects" },
        ...(projects.projects ?? []).map((project) => ({
          value: project.id,
          label: project.title,
        })),
      ],
      onChange: (value) => scope(value === "" ? null : (value as ProjectId)),
    },
    {
      label: "Workflows",
      onSelect: () =>
        props.navigate(
          projectId === null
            ? { pageId: "workflows.library" }
            : { pageId: "workflows.library", projectId },
        ),
    },
    { label: "Attention" },
  ];
  const stale = latest !== null && (offline || error !== null);
  return (
    <>
      <PageHeader breadcrumb={crumbs}>
        <span role="status" aria-live="polite" className="flex items-center gap-1.5">
          {latest === null || latest.total === 0 ? null : (
            <Badge variant="warning">
              {latest.total} {latest.total === 1 ? "run" : "runs"}
            </Badge>
          )}
          {stale ? <Badge variant="warning">Last loaded</Badge> : null}
        </span>
      </PageHeader>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 pt-6 pb-12 sm:px-6">
          <ProjectsAlert props={props} projects={projects} />
          {error === null ? null : (
            <Alert
              variant="error"
              title="Could not load attention"
              actions={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry
                </Button>
              }
            >
              {error}
            </Alert>
          )}
          {latest === null ? (
            offline ? (
              <Empty title="Not loaded" description="Attention loads after reconnecting." />
            ) : error === null ? (
              <p role="status" className="px-4 text-sm text-muted-foreground">
                Loading attention…
              </p>
            ) : null
          ) : latest.total === 0 ? (
            <Empty title="Nothing needs your attention" icon={<InboxIcon />} />
          ) : null}
          {runs.map((run) => (
            <RunGroup
              key={run.runId}
              props={props}
              run={run}
              projectTitle={projectId === null ? projectTitle(run.projectId) : null}
              onProject={() => scope(run.projectId)}
            />
          ))}
          {capped ? (
            <p role="status" className="px-4 text-xs text-muted-foreground">
              Newest {runs.length} of {latest.total}
              {projectId === null ? " · open a run's project to see the rest" : ""}
            </p>
          ) : latest !== null && (runs.length < latest.total || loading) ? (
            <div className="flex flex-col items-center gap-1">
              <span role="status" className="text-xs tabular-nums text-muted-foreground">
                Newest {runs.length} of {latest.total}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!live || loading}
                onClick={() => setLimit((value) => Math.min(MAX, value + PAGE))}
              >
                {loading ? "Loading older runs…" : "Load older runs"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** One run's items, each with the exact place to resolve it. */
function RunGroup({
  props,
  run,
  projectTitle,
  onProject,
}: {
  readonly props: PageProps;
  readonly run: AttentionRun;
  /** Shown when the page spans every project. */
  readonly projectTitle: string | null;
  readonly onProject: () => void;
}) {
  const { Button, Badge, ListGroup, ListRow, Tooltip } = props;
  const title = run.workflowTitle || run.runId;
  return (
    <ListGroup
      title={title}
      ariaLabel={`Attention for ${title}`}
      action={
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant={runStateVariant(run.state)}>{runStateLabels[run.state]}</Badge>
          {projectTitle === null ? null : (
            <Button
              size="xs"
              variant="ghost"
              ariaLabel={`Show workflow attention for project ${projectTitle}`}
              onClick={onProject}
            >
              {projectTitle}
            </Button>
          )}
          <span className="flex shrink-0 tabular-nums">
            <Tooltip content={formatTime(run.createdAt)}>{relativeTime(run.createdAt)}</Tooltip>
          </span>
          <Button
            size="xs"
            variant="ghost"
            ariaLabel={`Open run ${run.workflowTitle} from ${formatTime(run.createdAt)}`}
            onClick={() =>
              props.navigate({
                pageId: "workflows.runs",
                projectId: run.projectId,
                state: { run: run.runId },
              })
            }
          >
            Open run
          </Button>
        </span>
      }
    >
      {run.items.map((item) => (
        <Item key={item.id} props={props} run={run} item={item} />
      ))}
      {run.itemTotal > run.items.length ? (
        <ListRow
          title={`${run.itemTotal - run.items.length} more`}
          openLabel={`Open run ${run.workflowTitle} for ${run.itemTotal - run.items.length} more`}
          onOpen={() =>
            props.navigate({
              pageId: "workflows.runs",
              projectId: run.projectId,
              state: { run: run.runId },
            })
          }
        />
      ) : null}
    </ListGroup>
  );
}

function Item({
  props,
  run,
  item,
}: {
  readonly props: PageProps;
  readonly run: AttentionRun;
  readonly item: AttentionItem;
}) {
  const { Button, Badge, ListRow } = props;
  const open = (state: Record<string, string>) =>
    props.navigate({
      pageId: "workflows.runs",
      projectId: run.projectId,
      state: { run: run.runId, ...state },
    });
  const recovery = [
    run.allowedActions.includes("resume") ? "Resume" : null,
    run.allowedActions.includes("retry") ? "Retry" : null,
  ].filter((action) => action !== null);
  const stopped = item.kind !== "needs-review" && item.kind !== "needs-input";
  return (
    <ListRow
      title={item.title}
      leading={
        item.kind === "needs-review" ? (
          <GavelIcon />
        ) : item.kind === "needs-input" ? (
          <MessageCircleQuestionIcon />
        ) : (
          <CircleAlertIcon />
        )
      }
      badges={<Badge variant={stopped ? "warning" : "info"}>{attentionLabels[item.kind]}</Badge>}
      description={[
        attentionText(item),
        stopped
          ? recovery.length
            ? `${recovery.join(" or ")} available`
            : "Cancel to close"
          : null,
      ]
        .filter((part) => part !== null)
        .join(" · ")}
      actions={
        item.kind === "needs-review" ? (
          <Button size="xs" variant="outline" onClick={() => open({ node: item.nodeId })}>
            Open gate
          </Button>
        ) : item.kind === "needs-input" && item.threadId !== null ? (
          <>
            {item.attemptId === null ? null : (
              <Button size="xs" variant="ghost" onClick={() => open({ attempt: item.attemptId! })}>
                Show in run
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              ariaLabel={`Open the thread of ${item.title} to answer its request`}
              onClick={() =>
                props.openThread({
                  environmentId: props.environmentId,
                  projectId: run.projectId,
                  threadId: item.threadId!,
                })
              }
            >
              <MessageSquareIcon />
              Answer
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              open(item.attemptId === null ? { node: item.nodeId } : { attempt: item.attemptId })
            }
          >
            Inspect
          </Button>
        )
      }
    />
  );
}
