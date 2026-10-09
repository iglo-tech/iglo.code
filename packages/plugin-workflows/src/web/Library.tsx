import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileCodeIcon,
  FilePenLineIcon,
  FolderIcon,
  Trash2Icon,
  HistoryIcon,
  PlayIcon,
  PlusIcon,
  UploadIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Definition, LibraryEntry, LibraryPage, WorkflowPermissions } from "../contracts.ts";
import {
  draftKey,
  ProjectsAlert,
  noPermissions,
  projectCrumb,
  projectDrafts,
  readDraft,
  unusedWorkflowId,
  errorMessage,
  useProjects,
  writeDraft,
  type DraftEnvelope,
  type PageProps,
} from "./common.tsx";
import { authoringTimings, debounce } from "./timings.ts";
import { importYaml, newDefinition, slug } from "./editing.ts";

const PAGE_SIZE = 20;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
export function summaryText(summary: NonNullable<LibraryEntry["summary"]>): string {
  return [
    plural(summary.steps, "step"),
    summary.agents ? plural(summary.agents, "agent") : null,
    summary.reviewers ? plural(summary.reviewers, "reviewer") : null,
    summary.checks ? plural(summary.checks, "check") : null,
    summary.decisions ? plural(summary.decisions, "decision") : null,
    summary.humanGates ? plural(summary.humanGates, "human gate") : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export function LibraryPageView(props: PageProps) {
  return <Library key={`${props.environmentId}:${props.projectId}`} {...props} />;
}

function Library(props: PageProps) {
  const { client, projectId, connection, Button, Input, Badge, Textarea, Menu } = props;
  const { ListGroup, ListRow, Empty, Alert, PageHeader, Dialog, ConfirmDialog } = props;
  const projects = useProjects(props);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LibraryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState<string | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryEntry | null>(null);
  const [permissions, setPermissions] = useState<WorkflowPermissions>(noPermissions);
  useEffect(() => client.subscribePermissions(setPermissions), [client]);
  const offline = connection === "disconnected";
  const [localDrafts, setLocalDrafts] = useState(() =>
    projectId === null ? [] : projectDrafts(props.drafts, projectId),
  );

  useEffect(() => {
    if (query === search) return;
    return debounce(() => {
      setSearch(query);
      setOffset(0);
    }, authoringTimings.searchDelayMs);
  }, [query, search]);
  useEffect(() => {
    if (projectId === null || offline) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    client
      .library({
        projectId,
        offset,
        limit: PAGE_SIZE,
        ...(search.trim() === "" ? {} : { query: search.trim() }),
      })
      .then(
        (value) => {
          if (active) setPage(value);
        },
        (cause: unknown) => {
          if (active) setLoadError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, projectId, search, offset, attempt, offline]);

  const openDraft = (definition: Definition) => {
    if (projectId === null) return;
    const workflow = `new:${definition.id}:${Date.now().toString(36)}`;
    const envelope: DraftEnvelope = {
      version: 1,
      base: { mode: "new", source: null, fingerprint: null, revision: null },
      definition: { ...definition, revision: 1 },
      updatedAt: Date.now(),
    };
    if (!writeDraft(props.drafts, draftKey(projectId, workflow), envelope)) {
      setActionError("This browser could not keep a local draft. Free some site storage.");
      return;
    }
    props.navigate({ pageId: "workflows.editor", projectId, state: { draft: workflow } });
  };
  const open = (entry: LibraryEntry, extra: Record<string, string> = {}) => {
    if (projectId === null) return;
    props.navigate({
      pageId: "workflows.editor",
      projectId,
      state: { source: entry.source, ...extra },
    });
  };
  const clone = (entry: LibraryEntry) => {
    if (projectId === null) return;
    setActionError(null);
    client
      .read({ projectId, source: entry.source })
      .then(async (read) => {
        if (read.definition === null) return;
        const id = await unusedWorkflowId(
          client,
          props.drafts,
          projectId,
          slug(`${read.definition.id}-copy`),
        );
        openDraft({
          ...read.definition,
          id,
          title: `${read.definition.title} (copy)`,
          revision: 1,
        });
      })
      .catch((cause: unknown) => setActionError(errorMessage(cause)));
  };
  const remove = (entry: LibraryEntry) => {
    if (projectId === null) return;
    setActionError(null);
    client
      .remove({ projectId, source: entry.source, fingerprint: entry.fingerprint })
      .then(() => {
        // Unsaved edits of the deleted file would fail to save against a source that is gone;
        // keep them as a new unsaved workflow instead.
        const key = draftKey(projectId, entry.source);
        const stale = readDraft(props.drafts, key);
        if (stale !== null) {
          const moved: DraftEnvelope = {
            ...stale,
            base: { mode: "new", source: null, fingerprint: null, revision: null },
            updatedAt: Date.now(),
          };
          const workflow = `new:${stale.definition.id}:${Date.now().toString(36)}`;
          if (writeDraft(props.drafts, draftKey(projectId, workflow), moved))
            props.drafts.remove(key);
          setLocalDrafts(projectDrafts(props.drafts, projectId));
        }
        props.notify(`Deleted ${entry.title ?? entry.source}`);
        setAttempt((value) => value + 1);
      })
      .catch((cause: unknown) => setActionError(errorMessage(cause)));
  };
  const create = () => {
    if (name?.trim()) openDraft(newDefinition(name));
  };
  const startImport = () => {
    setName(null);
    setActionError(null);
    setImportText((value) => (value === null ? "" : value));
  };
  const startNew = () => {
    setImportText(null);
    setName((value) => (value === null ? "" : value));
  };

  const header = (
    <PageHeader breadcrumb={[projectCrumb(props, projects.projects), { label: "Workflows" }]}>
      {projectId === null ? null : (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => props.navigate({ pageId: "workflows.runs", projectId })}
          >
            <HistoryIcon />
            Runs
          </Button>
          <Menu
            ariaLabel="More workflow actions"
            items={[{ label: "Import YAML", icon: <UploadIcon />, onSelect: startImport }]}
          />
          <Button size="sm" onClick={startNew}>
            <PlusIcon />
            New workflow
          </Button>
        </>
      )}
    </PageHeader>
  );
  if (projectId === null)
    return (
      <>
        {header}
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 pt-6 pb-12 sm:px-6">
            <ProjectsAlert props={props} projects={projects} />
            {projects.projects === null ? (
              projects.error === null ? (
                <p role="status" className="px-4 text-sm text-muted-foreground">
                  Loading projects…
                </p>
              ) : null
            ) : projects.projects.length === 0 ? (
              <Empty title="No projects in this environment" icon={<WorkflowIcon />} />
            ) : (
              <ListGroup title="Choose a project">
                {projects.projects.map((project) => (
                  <ListRow
                    key={project.id}
                    title={project.title}
                    leading={<FolderIcon />}
                    onOpen={() =>
                      props.navigate({ pageId: "workflows.library", projectId: project.id })
                    }
                  />
                ))}
              </ListGroup>
            )}
          </div>
        </div>
      </>
    );
  const entries = page?.entries ?? [];
  const searching = search.trim() !== "";
  const visibleDrafts = searching
    ? localDrafts.filter((draft) => draft.title.toLowerCase().includes(search.trim().toLowerCase()))
    : localDrafts;
  return (
    <>
      {header}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Delete ${removing?.title ?? removing?.source ?? "workflow"}?`}
        description="This can't be undone. Past runs keep their snapshot."
        confirmLabel="Delete"
        onConfirm={() => removing !== null && remove(removing)}
      />
      <Dialog
        open={name !== null}
        onOpenChange={(open) => {
          if (!open) setName(null);
        }}
        title="New workflow"
        footer={
          <>
            <Button variant="ghost" onClick={() => setName(null)}>
              Cancel
            </Button>
            <Button disabled={!name?.trim()} onClick={create}>
              Create
            </Button>
          </>
        }
      >
        <form
          aria-label="New workflow"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <Input
            id="workflow-new-name"
            ariaLabel="Workflow name"
            autoFocus
            value={name ?? ""}
            onChange={setName}
            placeholder="Workflow name"
          />
        </form>
      </Dialog>
      <Dialog
        open={importText !== null}
        onOpenChange={(open) => {
          if (!open) {
            setImportText(null);
            setActionError(null);
          }
        }}
        title="Import YAML"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setImportText(null);
                setActionError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!importText?.trim()}
              onClick={() => {
                if (importText === null) return;
                const result = importYaml(importText);
                if (result._tag === "Failure") setActionError(result.message);
                else openDraft(result.definition);
              }}
            >
              Open as new draft
            </Button>
          </>
        }
      >
        {actionError === null ? null : (
          <Alert variant="error" title="Not imported">
            {actionError}
          </Alert>
        )}
        <div className="h-72">
          <Textarea
            id="workflow-import"
            ariaLabel="Workflow YAML to import"
            variant="code"
            placeholder="version: 1"
            value={importText ?? ""}
            onChange={setImportText}
          />
        </div>
      </Dialog>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 pt-6 pb-12 sm:px-6">
          <ProjectsAlert props={props} projects={projects} />
          {actionError === null || importText !== null ? null : (
            <Alert variant="error" title="Not opened">
              {actionError}
            </Alert>
          )}
          <div>
            <Input
              id="workflow-search"
              ariaLabel="Search workflows"
              type="search"
              size="sm"
              value={query}
              onChange={setQuery}
              placeholder="Search workflows"
            />
          </div>
          {visibleDrafts.length === 0 ? null : (
            <ListGroup title="Unsaved drafts" ariaLabel="Unsaved drafts">
              {visibleDrafts.map((draft) => (
                <ListRow
                  key={draft.key}
                  title={draft.title}
                  leading={<FilePenLineIcon />}
                  description={draft.isNew ? "New workflow" : "Unsaved changes"}
                  openLabel={`Open draft ${draft.title}`}
                  onOpen={() =>
                    props.navigate({ pageId: "workflows.editor", projectId, state: draft.state })
                  }
                  actions={
                    <Button
                      size="xs"
                      variant="ghost"
                      ariaLabel={`Discard draft ${draft.title}`}
                      onClick={() => {
                        props.drafts.remove(draft.key);
                        setLocalDrafts(projectDrafts(props.drafts, projectId));
                      }}
                    >
                      Discard
                    </Button>
                  }
                />
              ))}
            </ListGroup>
          )}
          {loadError === null ? null : (
            <Alert
              variant="error"
              title="Could not load workflows"
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
              {loadError}
            </Alert>
          )}
          {page === null ? (
            loadError === null && !offline ? (
              <p role="status" className="px-4 text-sm text-muted-foreground">
                Loading workflows…
              </p>
            ) : offline ? (
              <Empty title="Not loaded" description="Workflows load after reconnecting." />
            ) : null
          ) : entries.length === 0 ? (
            searching ? (
              <Empty title="No workflows match this search.">
                <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </Empty>
            ) : (
              <Empty title="No workflows yet" icon={<WorkflowIcon />}>
                <Button size="sm" onClick={startNew}>
                  <PlusIcon />
                  New workflow
                </Button>
                <Button size="sm" variant="outline" onClick={startImport}>
                  Import YAML
                </Button>
              </Empty>
            )
          ) : (
            <ListGroup
              {...(visibleDrafts.length === 0 ? {} : { title: "Workflows" })}
              ariaLabel="Workflows"
              busy={loading}
            >
              {entries.map((entry) => {
                const invalid = entry.definitionId === null || entry.duplicate;
                const label = entry.title ?? entry.source;
                return (
                  <ListRow
                    key={entry.source}
                    title={label}
                    leading={<WorkflowIcon />}
                    openLabel={`${invalid ? "Repair" : entry.packaged ? "View" : "Edit"} ${label}`}
                    onOpen={() => (invalid ? open(entry, { repair: "1" }) : open(entry))}
                    badges={
                      <>
                        {entry.packaged ? <Badge variant="secondary">Packaged</Badge> : null}
                        {entry.definitionId === null ? (
                          <Badge variant="error">Invalid file</Badge>
                        ) : null}
                        {entry.duplicate ? <Badge variant="error">Duplicate identity</Badge> : null}
                        {!invalid && !entry.runnable ? (
                          <Badge variant="warning">Needs attention</Badge>
                        ) : null}
                      </>
                    }
                    description={[
                      entry.summary === null ? null : summaryText(entry.summary),
                      entry.revision === null ? null : `Revision ${entry.revision}`,
                      entry.packaged ? null : entry.source,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                    actions={
                      <>
                        {invalid ? null : (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            ariaLabel={`Run ${label}`}
                            tooltip="Run workflow"
                            disabled={offline}
                            onClick={() =>
                              props.navigate({
                                pageId: "workflows.runs",
                                projectId,
                                state: { start: "1", workflow: entry.definitionId! },
                              })
                            }
                          >
                            <PlayIcon />
                          </Button>
                        )}
                        <Menu
                          ariaLabel={`Actions for ${label}`}
                          disabled={offline}
                          items={[
                            ...(invalid
                              ? [
                                  {
                                    label: "Repair",
                                    icon: <WrenchIcon />,
                                    onSelect: () => open(entry, { repair: "1" }),
                                  },
                                  {
                                    label: "Import replacement",
                                    icon: <UploadIcon />,
                                    onSelect: () => open(entry, { repair: "1", import: "1" }),
                                  },
                                ]
                              : []),
                            ...(entry.packaged
                              ? [
                                  {
                                    label: "Clone to edit",
                                    icon: <CopyIcon />,
                                    onSelect: () => clone(entry),
                                  },
                                ]
                              : []),
                            {
                              label: "Export YAML",
                              icon: <FileCodeIcon />,
                              onSelect: () => open(entry, { view: "yaml" }),
                            },
                            ...(entry.packaged
                              ? []
                              : [
                                  {
                                    label: "Delete",
                                    icon: <Trash2Icon />,
                                    destructive: true,
                                    disabled: !permissions.remove,
                                    onSelect: () => setRemoving(entry),
                                  },
                                ]),
                          ]}
                        />
                      </>
                    }
                  >
                    {entry.reasons.length === 0 ? null : (
                      <ul
                        aria-label={`Problems in ${label}`}
                        className="flex flex-col gap-0.5 pl-7 text-xs text-destructive"
                      >
                        {entry.reasons.map((reason, index) => (
                          <li key={index}>{reason}</li>
                        ))}
                      </ul>
                    )}
                  </ListRow>
                );
              })}
            </ListGroup>
          )}
          {page === null || page.total <= PAGE_SIZE ? null : (
            <nav aria-label="Workflow pages" className="flex items-center justify-end gap-1">
              <span className="mr-2 text-xs tabular-nums text-muted-foreground" role="status">
                {page.total === 0 ? 0 : page.offset + 1}–{page.offset + entries.length} of{" "}
                {page.total}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                ariaLabel="Previous"
                tooltip="Previous page"
                disabled={offline || page.offset === 0}
                onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                ariaLabel="Next"
                tooltip="Next page"
                disabled={offline || page.nextOffset === null}
                onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
              >
                <ChevronRightIcon />
              </Button>
            </nav>
          )}
        </div>
      </div>
    </>
  );
}
