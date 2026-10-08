import { useEffect, useMemo, useState } from "react";
import type {
  AuthoringEntry,
  Capabilities,
  Definition,
  Problem,
  WorkflowPermissions,
} from "../contracts.ts";
import {
  TargetBar,
  authoringTimings,
  debounce,
  draftKey,
  errorCode,
  errorMessage,
  readDraft,
  useNarrow,
  useProjects,
  writeDraft,
  type DraftBase,
  type PageProps,
} from "./common.tsx";
import {
  addStep,
  exportYaml,
  importYaml,
  localProblems,
  moveStep,
  removeStep,
  sameDefinition,
  slug,
  type EditableKind,
} from "./editing.ts";
import { Flow, Palette, RouteList, stepButtonId } from "./Flow.tsx";
import { Inspector, controlId } from "./Inspector.tsx";

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

const baseOf = (entry: AuthoringEntry): DraftBase => ({
  mode: entry.definition === null || entry.duplicate ? "replace" : "edit",
  source: entry.source,
  fingerprint: entry.fingerprint,
  revision: entry.definition?.revision ?? null,
});

export function EditorPageView(props: PageProps) {
  const workflow = props.pageState.source ?? props.pageState.draft ?? null;
  return (
    <Editor
      key={`${props.environmentId}:${props.projectId}:${workflow}`}
      {...props}
      workflow={workflow}
    />
  );
}

function Editor(props: PageProps & { readonly workflow: string | null }) {
  const { client, projectId, connection, workflow, pageState, Button, Badge, Textarea } = props;
  const source = pageState.source ?? null;
  const storageKey = projectId !== null && workflow !== null ? draftKey(projectId, workflow) : null;
  const [stored] = useState(() =>
    storageKey === null ? null : readDraft(props.drafts, storageKey),
  );
  const projects = useProjects(props);
  const narrow = useNarrow();
  const [server, setServer] = useState<AuthoringEntry | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [draft, setDraft] = useState<Definition | null>(stored?.definition ?? null);
  const [base, setBase] = useState<DraftBase | null>(stored?.base ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [checked, setChecked] = useState<{
    readonly json: string;
    readonly problems: ReadonlyArray<Problem>;
  } | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [capabilitiesAttempt, setCapabilitiesAttempt] = useState(0);
  const [permissions, setPermissions] = useState<WorkflowPermissions>({
    save: false,
    replace: false,
  });
  const [panel, setPanel] = useState<"import" | "export" | null>(
    pageState.import === "1" ? "import" : null,
  );
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<Definition | null>(null);
  const [compare, setCompare] = useState<AuthoringEntry | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [savedSource, setSavedSource] = useState<string | null>(null);
  const offline = connection === "disconnected";

  useEffect(() => client.subscribePermissions(setPermissions), [client]);
  useEffect(() => {
    if (projectId === null || source === null || offline) return;
    let active = true;
    setReadError(null);
    client.read({ projectId, source }).then(
      (entry) => {
        if (!active) return;
        setServer(entry);
        // A recovered local draft wins; otherwise edit the saved definition.
        setDraft((current) => current ?? entry.definition);
        setBase((current) => current ?? baseOf(entry));
        if (entry.definition === null) {
          setPanel("import");
          setImportText((current) => current || entry.text);
        }
      },
      (cause: unknown) => {
        if (active) setReadError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, source, offline, readAttempt]);
  useEffect(() => {
    if (projectId === null || offline) return;
    let active = true;
    setCapabilitiesError(null);
    client.capabilities(projectId).then(
      (value) => {
        if (active) setCapabilities(value);
      },
      (cause: unknown) => {
        if (active) setCapabilitiesError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, offline, capabilitiesAttempt]);

  const readOnly = server?.packaged === true;
  const dirty =
    draft !== null &&
    !readOnly &&
    (base?.mode !== "edit" || server === null || !sameDefinition(draft, server.definition));
  // Local drafts survive reloads and disconnection; saving or discarding clears them.
  useEffect(() => {
    if (storageKey === null || draft === null || base === null) return;
    if (!dirty) {
      props.drafts.remove(storageKey);
      return;
    }
    setStorageFailed(
      !writeDraft(props.drafts, storageKey, {
        version: 1,
        base,
        definition: draft,
        updatedAt: Date.now(),
      }),
    );
  }, [props.drafts, storageKey, draft, base, dirty]);

  const local = useMemo(() => (draft === null ? [] : localProblems(draft)), [draft]);
  const draftJson = useMemo(() => JSON.stringify(draft), [draft]);
  const locallyValid = !local.some((problem) => problem.severity === "error");
  useEffect(() => {
    if (draft === null || projectId === null || offline || !locallyValid) return;
    let active = true;
    const cancel = debounce(() => {
      client.validate({ projectId, definition: draft }).then(
        (entry) => {
          if (active)
            setChecked({
              json: draftJson,
              problems:
                entry.problems ??
                entry.reasons.map((message) => ({ severity: "error" as const, message })),
            });
        },
        () => {},
      );
    }, authoringTimings.validationDelayMs);
    return () => {
      active = false;
      cancel();
    };
  }, [client, projectId, offline, locallyValid, draft, draftJson]);
  const authoritative = checked !== null && checked.json === draftJson;
  const problems: ReadonlyArray<Problem> = locallyValid && authoritative ? checked.problems : local;
  const blocking = problems.some((problem) => problem.severity === "error");

  useEffect(() => {
    if (focus === null || typeof document === "undefined") return;
    document.getElementById(focus)?.focus();
    setFocus(null);
  }, [focus]);
  // Navigate only after the saved state renders clean so the guard does not hold it.
  useEffect(() => {
    if (savedSource === null || dirty || projectId === null) return;
    setSavedSource(null);
    if (savedSource !== source)
      props.navigate(
        { pageId: "workflows.editor", projectId, state: { source: savedSource } },
        { replace: true },
      );
  }, [savedSource, dirty, projectId, source, props]);

  const change = (next: Definition) => {
    if (readOnly) return;
    setDraft(next);
  };
  const select = (id: string | null) => {
    setSelected(id);
    if (narrow && id !== null) setInspectorOpen(true);
  };
  const discard = () => {
    if (storageKey !== null) props.drafts.remove(storageKey);
    setDraft(server?.definition ?? null);
    setBase(server === null ? null : baseOf(server));
    setStatus({ kind: "idle" });
    setCandidate(null);
  };
  const reload = () => {
    if (projectId === null || source === null) return;
    client.read({ projectId, source }).then(
      (entry) => {
        if (storageKey !== null) props.drafts.remove(storageKey);
        setServer(entry);
        setDraft(entry.definition);
        setBase(baseOf(entry));
        setCompare(null);
        setStatus({ kind: "idle" });
      },
      (cause: unknown) => setStatus({ kind: "failed", message: errorMessage(cause) }),
    );
  };
  const compareLatest = () => {
    if (projectId === null || source === null) return;
    client
      .read({ projectId, source })
      .then(setCompare, (cause: unknown) =>
        setStatus({ kind: "failed", message: errorMessage(cause) }),
      );
  };
  const keepMine = () => {
    if (projectId === null || source === null || base === null) return;
    client.read({ projectId, source }).then(
      (entry) => {
        setServer(entry);
        setBase({
          ...baseOf(entry),
          mode: base.mode === "replace" ? "replace" : baseOf(entry).mode,
        });
        setStatus({ kind: "idle" });
      },
      (cause: unknown) => setStatus({ kind: "failed", message: errorMessage(cause) }),
    );
  };
  const save = () => {
    if (draft === null || base === null || projectId === null) return;
    setStatus({ kind: "saving" });
    const request =
      base.mode === "replace" && base.source !== null && base.fingerprint !== null
        ? client.replace({
            projectId,
            source: base.source,
            fingerprint: base.fingerprint,
            definition: draft,
          })
        : client.save({
            projectId,
            definition: { ...draft, revision: (base.revision ?? 0) + 1 },
            expectedRevision: base.revision,
            ...(base.fingerprint === null ? {} : { fingerprint: base.fingerprint }),
          });
    request.then(
      (entry) => {
        if (storageKey !== null) props.drafts.remove(storageKey);
        setServer(entry);
        setDraft(entry.definition);
        setBase(baseOf(entry));
        setStatus({ kind: "idle" });
        setSavedSource(entry.source);
      },
      (cause: unknown) =>
        setStatus(
          errorCode(cause) === "conflict"
            ? { kind: "conflict", message: errorMessage(cause) }
            : { kind: "failed", message: errorMessage(cause) },
        ),
    );
  };
  const adopt = (definition: Definition) => {
    // Editing an existing file keeps its identity and expected revision.
    const next =
      base?.mode === "edit" && draft !== null
        ? { ...definition, id: draft.id, revision: draft.revision }
        : base === null || base.mode === "new"
          ? { ...definition, revision: 1 }
          : definition;
    setDraft(next);
    if (base === null)
      setBase(
        server === null
          ? { mode: "new", source: null, fingerprint: null, revision: null }
          : { ...baseOf(server), mode: "replace" },
      );
    setCandidate(null);
    setImportText("");
    setPanel(null);
    setSelected(null);
  };
  const clone = () => {
    if (draft === null || projectId === null) return;
    const workflowKey = `new:${draft.id}-copy:${Date.now().toString(36)}`;
    writeDraft(props.drafts, draftKey(projectId, workflowKey), {
      version: 1,
      base: { mode: "new", source: null, fingerprint: null, revision: null },
      definition: {
        ...draft,
        id: slug(`${draft.id}-copy`),
        title: `${draft.title} (copy)`,
        revision: 1,
      },
      updatedAt: Date.now(),
    });
    props.navigate({ pageId: "workflows.editor", projectId, state: { draft: workflowKey } });
  };
  const goTo = (problem: Problem) => {
    setSelected(problem.nodeId ?? null);
    if (narrow) setInspectorOpen(true);
    const target = controlId(problem.nodeId ?? null, problem.control ?? "title");
    setFocus(
      problem.control === undefined && problem.nodeId !== undefined
        ? stepButtonId(problem.nodeId)
        : typeof document !== "undefined" &&
            document.getElementById(target) === null &&
            problem.nodeId
          ? stepButtonId(problem.nodeId)
          : target,
    );
  };

  if (projectId === null || workflow === null)
    return (
      <section className="mx-auto w-full max-w-3xl px-6 py-8 text-sm">
        <p>Open a workflow from the Workflows library.</p>
        <div className="mt-4">
          <Button variant="outline" onClick={() => props.navigate({ pageId: "workflows.library" })}>
            Open library
          </Button>
        </div>
      </section>
    );
  const saveAllowed = base?.mode === "replace" ? permissions.replace : permissions.save;
  const statusText =
    status.kind === "saving"
      ? "Saving…"
      : readOnly
        ? "Packaged example · read-only"
        : dirty
          ? offline
            ? "Unsaved changes · disconnected, kept on this device"
            : "Unsaved changes"
          : base?.revision != null
            ? `Saved revision ${base.revision}`
            : "Not saved yet";
  const outdated =
    server !== null &&
    base !== null &&
    base.source === server.source &&
    base.fingerprint !== null &&
    base.fingerprint !== server.fingerprint;
  const exported = draft === null ? null : exportYaml(draft);
  const inspector =
    draft === null ? null : (
      <Inspector
        props={props}
        definition={draft}
        selected={selected}
        capabilities={capabilities}
        capabilitiesError={capabilitiesError}
        onRetryCapabilities={() => setCapabilitiesAttempt((value) => value + 1)}
        problems={problems}
        readOnly={readOnly}
        identityEditable={base?.mode !== "edit"}
        onChange={change}
      />
    );
  const palette =
    draft === null ? null : (
      <Palette
        props={props}
        capabilities={capabilities}
        disabled={readOnly}
        onAdd={(kind: EditableKind) => {
          const added = addStep(draft, kind, selected, capabilities);
          change(added.definition);
          setPaletteOpen(false);
          select(added.id);
        }}
      />
    );
  return (
    <section className="flex w-full flex-col gap-5 px-6 py-6">
      <props.NavigationGuard
        when={dirty}
        title="Leave with unsaved workflow changes?"
        description="Keep editing to save them, or discard this local draft."
        onDiscard={() => {
          if (storageKey !== null) props.drafts.remove(storageKey);
        }}
      />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold tracking-tight">
            {draft?.title || server?.source || "Workflow"}
          </h1>
          <p role="status" aria-live="polite" className="mt-1 text-sm text-muted-foreground">
            {statusText}
            {problems.length > 0 && draft !== null
              ? ` · ${problems.filter((problem) => problem.severity === "error").length} to fix`
              : ""}
            {draft !== null && locallyValid && !authoritative && !offline
              ? " · checking with the server…"
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={() => props.navigate({ pageId: "workflows.library", projectId })}
          >
            Library
          </Button>
          {readOnly ? (
            <Button onClick={clone}>Clone to edit</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setPanel((value) => (value === "import" ? null : "import"))}
              >
                Import YAML
              </Button>
              <Button
                variant="outline"
                disabled={draft === null}
                onClick={() => setPanel((value) => (value === "export" ? null : "export"))}
              >
                Export YAML
              </Button>
              {dirty && base?.mode !== "new" ? (
                <Button variant="ghost" onClick={discard}>
                  Discard changes
                </Button>
              ) : null}
              <Button
                disabled={
                  draft === null ||
                  !dirty ||
                  offline ||
                  !saveAllowed ||
                  blocking ||
                  status.kind === "saving"
                }
                onClick={save}
              >
                {base?.mode === "replace" ? "Validate and replace file" : "Save"}
              </Button>
            </>
          )}
        </div>
      </div>
      <TargetBar
        props={props}
        projects={projects.projects}
        projectsError={projects.error}
        onRetry={projects.retry}
      />
      {server === null || server.packaged ? null : (
        <p className="text-xs text-muted-foreground">Source: {server.source}</p>
      )}
      {!offline && !saveAllowed && !readOnly ? (
        <p role="status" className="text-sm text-muted-foreground">
          This connection can view workflows but is not allowed to save them.
        </p>
      ) : null}
      {offline ? (
        <p role="status" className="text-sm text-warning-foreground">
          Disconnected. Your draft stays on this device; saving resumes after this environment
          reconnects.
          {server !== null ? " The saved version shown may be out of date." : ""}
        </p>
      ) : null}
      {storageFailed ? (
        <p role="alert" className="text-sm text-destructive">
          This draft is too large to keep on this device. Save it to avoid losing changes.
        </p>
      ) : null}
      {readError === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Could not load this workflow: {readError}</span>
          <Button size="sm" variant="outline" onClick={() => setReadAttempt((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
      {status.kind === "failed" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Not saved: {status.message} Your edits are kept.</span>
          <Button size="sm" variant="outline" disabled={offline || blocking} onClick={save}>
            Retry save
          </Button>
        </div>
      ) : null}
      {status.kind === "conflict" || outdated ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
        >
          <p>
            {status.kind === "conflict"
              ? `This workflow changed on the server: ${status.message}`
              : "The saved workflow changed since this draft was started."}{" "}
            Your edits are kept.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={offline} onClick={compareLatest}>
              Compare
            </Button>
            <Button size="sm" variant="outline" disabled={offline} onClick={reload}>
              Reload saved version
            </Button>
            <Button size="sm" variant="ghost" disabled={offline} onClick={keepMine}>
              Keep my draft for the next save
            </Button>
          </div>
        </div>
      ) : null}
      {compare === null || draft === null ? null : (
        <div className="grid gap-3 md:grid-cols-2" aria-label="Compare versions">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="wf-compare-server"
              className="text-xs font-medium text-muted-foreground"
            >
              Saved on server
              {compare.definition ? ` (revision ${compare.definition.revision})` : ""}
            </label>
            <Textarea
              id="wf-compare-server"
              rows={14}
              readOnly
              value={compare.text}
              onChange={() => {}}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="wf-compare-draft" className="text-xs font-medium text-muted-foreground">
              Your draft
            </label>
            <Textarea
              id="wf-compare-draft"
              rows={14}
              readOnly
              value={exportYaml(draft).text}
              onChange={() => {}}
            />
          </div>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setCompare(null)}>
              Close comparison
            </Button>
          </div>
        </div>
      )}
      {panel === "import" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <label htmlFor="wf-import" className="text-xs font-medium text-muted-foreground">
            {server?.definition === null
              ? "Repair this file: edit its YAML, then load it as a candidate"
              : "Workflow YAML"}
          </label>
          {server !== null && !server.lossless ? (
            <p className="text-xs text-warning-foreground">
              Protected values in this file are hidden. Re-enter them before replacing it.
            </p>
          ) : null}
          <Textarea
            id="wf-import"
            ariaLabel="Workflow YAML to import"
            rows={10}
            value={importText}
            onChange={setImportText}
          />
          {importError === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {importError} Your current draft is unchanged.
            </p>
          )}
          {candidate === null ? (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!importText.trim()}
                onClick={() => {
                  const result = importYaml(importText);
                  if (result._tag === "Failure") {
                    setImportError(result.message);
                    setCandidate(null);
                  } else {
                    setImportError(null);
                    setCandidate(result.definition);
                  }
                }}
              >
                Load candidate
              </Button>
              <Button variant="ghost" onClick={() => setPanel(null)}>
                Close
              </Button>
            </div>
          ) : (
            <div role="status" className="flex flex-col gap-2 text-sm">
              <p>
                Candidate “{candidate.title}” with {candidate.nodes.length} steps is ready.
                {base?.mode === "edit" && draft !== null && candidate.id !== draft.id
                  ? ` It keeps this workflow's identity ${draft.id}.`
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => adopt(candidate)}>Replace draft with candidate</Button>
                <Button variant="ghost" onClick={() => setCandidate(null)}>
                  Keep current draft
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
      {panel === "export" && exported !== null ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <label htmlFor="wf-export" className="text-xs font-medium text-muted-foreground">
            Canonical YAML
          </label>
          <Textarea
            id="wf-export"
            ariaLabel="Exported workflow YAML"
            rows={12}
            readOnly
            value={exported.text}
            onChange={() => {}}
          />
          {exported.protectedValues > 0 ? (
            <p className="text-xs text-muted-foreground">
              {exported.protectedValues} protected value
              {exported.protectedValues === 1 ? " appears" : "s appear"} as placeholders. The export
              is not lossless: placeholders are restored only when saved back to this project while
              the original file is unchanged.
            </p>
          ) : null}
        </div>
      ) : null}
      {draft === null ? (
        server === null ? (
          readError === null && !offline ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading workflow…
            </p>
          ) : null
        ) : (
          <div role="alert" className="flex flex-col gap-1 text-sm">
            <p className="font-medium">This file is not a valid workflow.</p>
            <ul className="text-destructive">
              {server.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          </div>
        )
      ) : (
        <>
          {narrow && !readOnly ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setPaletteOpen(true)}>
                Add a step
              </Button>
              <Button variant="outline" onClick={() => setInspectorOpen(true)}>
                {selected === null ? "Workflow settings" : "Inspector"}
              </Button>
            </div>
          ) : null}
          <div
            className={
              narrow ? "flex flex-col gap-6" : "grid grid-cols-[12rem_minmax(0,1fr)_22rem] gap-6"
            }
          >
            {narrow ? null : <div>{readOnly ? null : palette}</div>}
            <div className="flex min-w-0 flex-col gap-6">
              <Flow
                props={props}
                definition={draft}
                selected={selected}
                problems={problems}
                readOnly={readOnly}
                onSelect={(id) => select(selected === id ? null : id)}
                onMove={(id, offset) => change(moveStep(draft, id, offset))}
                onRemove={(id) => {
                  change(removeStep(draft, id));
                  if (selected === id) setSelected(null);
                }}
              />
              <RouteList definition={draft} />
              <section aria-labelledby="wf-problems-title" className="flex flex-col gap-2">
                <h2 id="wf-problems-title" className="text-sm font-medium">
                  Problems to fix
                </h2>
                {problems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {authoritative ? "No problems. Ready to save." : "No problems found locally."}
                  </p>
                ) : (
                  <ul aria-label="Problems to fix" className="flex flex-col gap-1">
                    {problems.map((problem, index) => (
                      <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant={problem.severity === "error" ? "error" : "warning"}>
                          {problem.severity === "error" ? "Blocks saving" : "Warning"}
                        </Badge>
                        <span className="min-w-0 flex-1 break-words">{problem.message}</span>
                        {problem.nodeId !== undefined || problem.control !== undefined ? (
                          <Button size="sm" variant="ghost" onClick={() => goTo(problem)}>
                            Show
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
            {narrow ? null : <div>{inspector}</div>}
          </div>
          {narrow ? (
            <>
              <props.Sheet
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                title="Add a step"
                side="bottom"
              >
                {palette}
              </props.Sheet>
              <props.Sheet open={inspectorOpen} onOpenChange={setInspectorOpen} title="Inspector">
                {inspector}
              </props.Sheet>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
