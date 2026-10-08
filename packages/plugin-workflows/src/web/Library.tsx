import { useEffect, useState } from "react";
import type { Definition, LibraryEntry, LibraryPage } from "../contracts.ts";
import {
  TargetBar,
  draftKey,
  projectDrafts,
  unusedWorkflowId,
  errorMessage,
  useProjects,
  writeDraft,
  type DraftEnvelope,
  type PageProps,
} from "./common.tsx";
import { authoringTimings, debounce } from "./timings.ts";
import { exportYaml, importYaml, newDefinition, slug } from "./editing.ts";

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
  const { client, projectId, connection, Button, Input, Badge, Textarea } = props;
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
  const [exported, setExported] = useState<{
    readonly source: string;
    readonly text: string;
    readonly note: string | null;
  } | null>(null);
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
      setActionError(
        "This browser could not keep a local draft. Free some site storage and retry.",
      );
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
  const exportEntry = (entry: LibraryEntry) => {
    if (projectId === null) return;
    setActionError(null);
    client.read({ projectId, source: entry.source }).then(
      (read) => {
        const counted =
          read.definition === null ? null : exportYaml(read.definition).protectedValues;
        setExported({
          source: entry.source,
          text: read.text,
          note: !read.lossless
            ? "Protected values in this file were hidden and cannot be exported."
            : counted
              ? `${plural(counted, "protected value")} appear as placeholders. They are restored only when saved back to this project while its file is unchanged.`
              : null,
        });
      },
      (cause: unknown) => setActionError(errorMessage(cause)),
    );
  };

  if (projectId === null)
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
        <TargetBar
          props={props}
          projects={projects.projects}
          projectsError={projects.error}
          onRetry={projects.retry}
        />
        <p className="text-sm text-muted-foreground">
          Choose a project in this environment to see its workflows.
        </p>
      </section>
    );
  const entries = page?.entries ?? [];
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved and packaged workflows for this project.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setName((value) => (value === null ? "" : null))}>
            New workflow
          </Button>
          <Button
            variant="outline"
            onClick={() => setImportText((value) => (value === null ? "" : null))}
          >
            Import YAML
          </Button>
        </div>
      </div>
      <TargetBar
        props={props}
        projects={projects.projects}
        projectsError={projects.error}
        onRetry={projects.retry}
      />
      {name === null ? null : (
        <form
          className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-4"
          aria-label="New workflow"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) openDraft(newDefinition(name));
          }}
        >
          <div className="flex min-w-64 flex-1 flex-col gap-1.5">
            <label
              htmlFor="workflow-new-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Workflow name
            </label>
            <Input
              id="workflow-new-name"
              ariaLabel="Workflow name"
              value={name}
              onChange={setName}
              placeholder="Implement and review"
            />
          </div>
          <Button disabled={!name.trim()} onClick={() => openDraft(newDefinition(name))}>
            Create
          </Button>
          <Button variant="ghost" onClick={() => setName(null)}>
            Cancel
          </Button>
        </form>
      )}
      {importText === null ? null : (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <label htmlFor="workflow-import" className="text-xs font-medium text-muted-foreground">
            Workflow YAML
          </label>
          <Textarea
            id="workflow-import"
            ariaLabel="Workflow YAML to import"
            rows={8}
            value={importText}
            onChange={setImportText}
          />
          <div className="flex gap-2">
            <Button
              disabled={!importText.trim()}
              onClick={() => {
                const result = importYaml(importText);
                if (result._tag === "Failure") setActionError(result.message);
                else openDraft(result.definition);
              }}
            >
              Open as new draft
            </Button>
            <Button variant="ghost" onClick={() => setImportText(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {localDrafts.length === 0 || projectId === null ? null : (
        <section aria-labelledby="wf-local-drafts" className="flex flex-col gap-2">
          <h2 id="wf-local-drafts" className="text-sm font-medium">
            Unsaved drafts on this device
          </h2>
          <ul aria-label="Unsaved drafts" className="flex flex-col gap-1">
            {localDrafts.map((draft) => (
              <li key={draft.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words">
                  {draft.title}
                  {draft.isNew ? " · new workflow" : " · unsaved changes"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  ariaLabel={`Open draft ${draft.title}`}
                  onClick={() =>
                    props.navigate({ pageId: "workflows.editor", projectId, state: draft.state })
                  }
                >
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  ariaLabel={`Discard draft ${draft.title}`}
                  onClick={() => {
                    props.drafts.remove(draft.key);
                    setLocalDrafts(projectDrafts(props.drafts, projectId));
                  }}
                >
                  Discard
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {actionError === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {exported === null ? null : (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <label htmlFor="workflow-export" className="text-xs font-medium text-muted-foreground">
            Canonical YAML for {exported.source}
          </label>
          <Textarea
            id="workflow-export"
            ariaLabel="Exported workflow YAML"
            rows={10}
            readOnly
            value={exported.text}
            onChange={() => {}}
          />
          {exported.note === null ? null : (
            <p className="text-xs text-muted-foreground">{exported.note}</p>
          )}
          <div>
            <Button variant="ghost" size="sm" onClick={() => setExported(null)}>
              Close export
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="workflow-search" className="text-xs font-medium text-muted-foreground">
          Search workflows
        </label>
        <Input
          id="workflow-search"
          ariaLabel="Search workflows"
          type="search"
          value={query}
          onChange={setQuery}
          placeholder="Name, identity or file"
        />
      </div>
      {offline ? (
        <p role="status" className="text-sm text-muted-foreground">
          {page === null
            ? "Disconnected. Workflows load when this environment reconnects."
            : "Disconnected. Showing the last loaded workflows; they may be out of date."}
        </p>
      ) : null}
      {loadError === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Could not load workflows: {loadError}</span>
          <Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      {page === null ? (
        loadError === null && !offline ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading workflows…
          </p>
        ) : null
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search.trim()
            ? "No workflows match this search."
            : "No workflows yet. Create one or import YAML."}
        </p>
      ) : (
        <ul aria-label="Workflows" aria-busy={loading} className="divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.source} className="flex flex-col gap-2 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words text-sm font-medium">
                  {entry.title ?? entry.source}
                </h2>
                {entry.packaged ? <Badge variant="secondary">Packaged · read-only</Badge> : null}
                {entry.definitionId === null ? <Badge variant="error">Invalid file</Badge> : null}
                {entry.duplicate ? <Badge variant="error">Duplicate identity</Badge> : null}
                {entry.definitionId !== null && !entry.duplicate ? (
                  entry.runnable ? (
                    <Badge variant="success">Runnable</Badge>
                  ) : (
                    <Badge variant="warning">Needs attention</Badge>
                  )
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  entry.summary === null ? null : summaryText(entry.summary),
                  entry.revision === null ? null : `Saved revision ${entry.revision}`,
                  entry.packaged ? null : entry.source,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </p>
              {entry.reasons.length === 0 ? null : (
                <ul aria-label={`Problems in ${entry.title ?? entry.source}`} className="text-xs">
                  {entry.reasons.map((reason, index) => (
                    <li key={index} className="text-destructive">
                      {reason}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {entry.definitionId === null || entry.duplicate ? (
                  <>
                    <Button
                      size="sm"
                      disabled={offline}
                      onClick={() => open(entry, { repair: "1" })}
                    >
                      Repair
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={offline}
                      onClick={() => open(entry, { repair: "1", import: "1" })}
                    >
                      Import replacement
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => open(entry)}>
                    {entry.packaged ? "View" : "Edit"}
                  </Button>
                )}
                {entry.packaged ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offline}
                    onClick={() => clone(entry)}
                  >
                    Clone to edit
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={offline}
                  onClick={() => exportEntry(entry)}
                >
                  Export YAML
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {page === null || page.total <= PAGE_SIZE ? null : (
        <nav aria-label="Workflow pages" className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground" role="status">
            Showing {page.total === 0 ? 0 : page.offset + 1}–{page.offset + entries.length} of{" "}
            {page.total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offline || page.offset === 0}
              onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offline || page.nextOffset === null}
              onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
            >
              Next
            </Button>
          </div>
        </nav>
      )}
    </section>
  );
}
