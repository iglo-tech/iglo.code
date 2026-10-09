import {
  CircleAlertIcon,
  CopyIcon,
  FileCodeIcon,
  PanelRightIcon,
  PlusIcon,
  Undo2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthoringEntry,
  Capabilities,
  Definition,
  Problem,
  WorkflowPermissions,
} from "../contracts.ts";
import {
  ProjectsAlert,
  noPermissions,
  draftKey,
  projectCrumb,
  unusedWorkflowId,
  errorCode,
  errorMessage,
  readDraft,
  useNarrow,
  useProjects,
  writeDraft,
  type DraftBase,
  type PageProps,
} from "./common.tsx";
import { authoringTimings, debounce } from "./timings.ts";
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
import { Palette, RouteList, stepButtonId } from "./Flow.tsx";
import { Graph } from "./Graph.tsx";
import { Inspector, controlId } from "./Inspector.tsx";

type View = "graph" | "routes" | "yaml";
/** React Flow needs layout measurement; without it (server rendering, tests) Routes is shown. */
const canvasSupported = () => typeof ResizeObserver !== "undefined";
const defaultView = (): View => (canvasSupported() ? "graph" : "routes");

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
  const { Alert, Empty, Menu, PageHeader, SegmentedControl } = props;
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
  const [statusKind, setStatus] = useState<Status>({ kind: "idle" });
  const [checked, setChecked] = useState<{
    readonly json: string;
    readonly problems: ReadonlyArray<Problem>;
  } | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [capabilitiesAttempt, setCapabilitiesAttempt] = useState(0);
  const [permissions, setPermissions] = useState<WorkflowPermissions>(noPermissions);
  const [view, setView] = useState<View>(() =>
    pageState.import === "1" || pageState.view === "yaml" ? "yaml" : defaultView(),
  );
  const [importing, setImporting] = useState(pageState.import === "1");
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
          setView("yaml");
          setImporting(true);
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
  // A new workflow is unsaved until its first save; otherwise compare with the saved file.
  const dirty = useMemo(
    () =>
      draft !== null &&
      !readOnly &&
      (base?.mode === "new" || server === null || !sameDefinition(draft, server.definition)),
    [draft, readOnly, base?.mode, server],
  );
  // Local drafts survive reloads and disconnection; saving or discarding clears them. Writes
  // are coalesced while typing and flushed when the page closes.
  const exported = useMemo(
    () => (view === "yaml" && !importing && draft !== null ? exportYaml(draft) : null),
    [view, importing, draft],
  );
  const pendingWrite = useRef<(() => void) | null>(null);
  useEffect(() => {
    pendingWrite.current = null;
    if (storageKey === null || draft === null || base === null) return;
    if (!dirty) {
      props.drafts.remove(storageKey);
      return;
    }
    const write = () => {
      pendingWrite.current = null;
      setStorageFailed(
        !writeDraft(props.drafts, storageKey, {
          version: 1,
          base,
          definition: draft,
          updatedAt: Date.now(),
        }),
      );
    };
    pendingWrite.current = write;
    return debounce(write, authoringTimings.draftDelayMs);
  }, [props.drafts, storageKey, draft, base, dirty]);
  useEffect(() => {
    // A reload or tab close never unmounts; flush a pending write when the page is hidden.
    const flush = () => pendingWrite.current?.();
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    if (typeof globalThis.addEventListener === "function")
      globalThis.addEventListener("pagehide", flush);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
    return () => {
      flush();
      if (typeof globalThis.removeEventListener === "function")
        globalThis.removeEventListener("pagehide", flush);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const forget = () => {
    pendingWrite.current = null;
    if (storageKey !== null) props.drafts.remove(storageKey);
  };

  const local = useMemo(() => (draft === null ? [] : localProblems(draft)), [draft]);
  const draftJson = useMemo(() => JSON.stringify(draft), [draft]);
  const locallyValid = !local.some((problem) => problem.severity === "error");
  const [validationFailure, setValidationFailure] = useState<{
    readonly json: string;
    readonly message: string;
  } | null>(null);
  const [validateAttempt, setValidateAttempt] = useState(0);
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
        (cause: unknown) => {
          if (active) setValidationFailure({ json: draftJson, message: errorMessage(cause) });
        },
      );
    }, authoringTimings.validationDelayMs);
    return () => {
      active = false;
      cancel();
    };
  }, [client, projectId, offline, locallyValid, draft, draftJson, validateAttempt]);
  const validationUnavailable =
    validationFailure !== null && validationFailure.json === draftJson ? validationFailure : null;
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
  // Stable so the graph's memoized handlers survive edits.
  const removeSelected = useCallback(
    (id: string) => {
      if (readOnly) return;
      setDraft((current) => (current === null ? current : removeStep(current, id)));
      setSelected((current) => (current === id ? null : current));
    },
    [readOnly],
  );
  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (narrow && id !== null) setInspectorOpen(true);
    },
    [narrow],
  );
  const discard = () => {
    forget();
    setDraft(server?.definition ?? null);
    setBase(server === null ? null : baseOf(server));
    setStatus({ kind: "idle" });
    setCandidate(null);
  };
  const reload = () => {
    if (projectId === null || source === null) return;
    client.read({ projectId, source }).then(
      (entry) => {
        forget();
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
        forget();
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
    setImporting(false);
    setView(defaultView());
    setSelected(null);
  };
  const clone = () => {
    if (draft === null || projectId === null) return;
    const original = draft;
    void unusedWorkflowId(client, props.drafts, projectId, slug(`${original.id}-copy`)).then(
      (id) => {
        const workflowKey = `new:${id}:${Date.now().toString(36)}`;
        writeDraft(props.drafts, draftKey(projectId, workflowKey), {
          version: 1,
          base: { mode: "new", source: null, fingerprint: null, revision: null },
          definition: { ...original, id, title: `${original.title} (copy)`, revision: 1 },
          updatedAt: Date.now(),
        });
        props.navigate({ pageId: "workflows.editor", projectId, state: { draft: workflowKey } });
      },
      (cause: unknown) => setStatus({ kind: "failed", message: errorMessage(cause) }),
    );
  };
  const goTo = (problem: Problem) => {
    setSelected(problem.nodeId ?? null);
    if (view === "yaml" && problem.nodeId !== undefined) setView(defaultView());
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

  const libraryLink = () =>
    projectId === null
      ? props.navigate({ pageId: "workflows.library" })
      : props.navigate({ pageId: "workflows.library", projectId });
  const breadcrumb = (current: string) => [
    projectCrumb(props, projects.projects),
    { label: "Workflows", onSelect: libraryLink },
    { label: current },
  ];
  if (projectId === null || workflow === null)
    return (
      <>
        <PageHeader breadcrumb={breadcrumb("Editor")} />
        <Empty title="Open a workflow from the library">
          <Button size="sm" variant="outline" onClick={libraryLink}>
            Open library
          </Button>
        </Empty>
      </>
    );
  if (source === null && draft === null)
    return (
      <>
        <PageHeader breadcrumb={breadcrumb("Draft")} />
        <Empty title="This draft is no longer on this device">
          <Button size="sm" variant="outline" onClick={libraryLink}>
            Open library
          </Button>
        </Empty>
      </>
    );
  const saveAllowed = base?.mode === "replace" ? permissions.replace : permissions.save;
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.length - errors;
  // Narrow headers keep the title readable: passive states hide and warnings shorten.
  const statusBadge =
    statusKind.kind === "saving" ? (
      <Badge variant="secondary">Saving…</Badge>
    ) : readOnly ? (
      <span className="max-sm:hidden">
        <Badge variant="secondary">Packaged · read-only</Badge>
      </span>
    ) : dirty ? (
      <Badge variant="warning">
        <span className="max-sm:hidden">
          {offline ? "Unsaved · kept on this device" : "Unsaved changes"}
        </span>
        <span className="sm:hidden">Unsaved</span>
      </Badge>
    ) : (
      <span className="max-sm:hidden">
        <Badge variant="outline">
          {base?.revision != null ? `Saved revision ${base.revision}` : "Not saved yet"}
        </Badge>
      </span>
    );
  const outdated =
    server !== null &&
    base !== null &&
    base.source === server.source &&
    base.fingerprint !== null &&
    base.fingerprint !== server.fingerprint;
  const showProblems = () => {
    setSelected(null);
    if (narrow) setInspectorOpen(true);
    setFocus("wf-problems");
  };
  const openImport = () => {
    setCompare(null);
    setImporting(true);
    setView("yaml");
  };
  const inspector =
    draft === null ? null : (
      <div className="flex flex-col gap-5">
        {selected === null && problems.length > 0 ? (
          <section aria-labelledby="wf-problems-title" className="flex flex-col gap-2">
            <h2 id="wf-problems-title" className="flex items-center gap-1.5 text-sm font-medium">
              Problems to fix
            </h2>
            <ul
              id="wf-problems"
              tabIndex={-1}
              aria-label="Problems to fix"
              className="flex flex-col gap-1 outline-none"
            >
              {problems.map((problem, index) => (
                <li key={index} className="flex items-start gap-2 text-xs">
                  <CircleAlertIcon
                    aria-hidden
                    className={`mt-0.5 size-3.5 shrink-0 ${problem.severity === "error" ? "text-destructive" : "text-warning"}`}
                  />
                  <span className="min-w-0 flex-1 break-words">
                    <span className="sr-only">
                      {problem.severity === "error" ? "Blocks saving: " : "Warning: "}
                    </span>
                    {problem.message}
                  </span>
                  {problem.nodeId !== undefined || problem.control !== undefined ? (
                    <Button size="xs" variant="ghost" onClick={() => goTo(problem)}>
                      Show
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
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
      </div>
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
  const alerts = [
    projects.error === null ? null : (
      <ProjectsAlert key="projects" props={props} projects={projects} />
    ),
    storageFailed ? (
      <Alert key="storage" variant="error" title="Draft not kept on this device">
        Save to avoid losing changes.
      </Alert>
    ) : null,
    readError === null ? null : (
      <Alert
        key="read"
        variant="error"
        title="Could not load this workflow"
        actions={
          <Button size="xs" variant="outline" onClick={() => setReadAttempt((value) => value + 1)}>
            Retry
          </Button>
        }
      >
        {readError}
      </Alert>
    ),
    statusKind.kind === "failed" ? (
      <Alert
        key="failed"
        variant="error"
        title="Not saved · edits kept"
        actions={
          <Button size="xs" variant="outline" disabled={offline || blocking} onClick={save}>
            Retry save
          </Button>
        }
      >
        {statusKind.message}
      </Alert>
    ) : null,
    validationUnavailable === null || authoritative ? null : (
      <Alert
        key="validation"
        variant="warning"
        title="Validation unavailable"
        actions={
          <Button
            size="xs"
            variant="outline"
            ariaLabel="Retry validation"
            disabled={offline}
            onClick={() => setValidateAttempt((value) => value + 1)}
          >
            Retry
          </Button>
        }
      >
        {validationUnavailable.message}
      </Alert>
    ),
    statusKind.kind === "conflict" && base?.mode === "new" ? (
      <Alert
        key="identity"
        variant="error"
        title="Not saved · draft kept"
        actions={
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setStatus({ kind: "idle" });
              setSelected(null);
              if (narrow) setInspectorOpen(true);
              setFocus(controlId(null, "id"));
            }}
          >
            Change workflow ID
          </Button>
        }
      >
        {statusKind.message}
      </Alert>
    ) : statusKind.kind === "conflict" || outdated ? (
      <Alert
        key="conflict"
        variant="warning"
        title="This workflow changed on the server"
        actions={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={offline}
              onClick={() => {
                compareLatest();
                setView("yaml");
                setImporting(false);
              }}
            >
              Compare
            </Button>
            <Button size="xs" variant="outline" disabled={offline} onClick={reload}>
              Reload saved version
            </Button>
            <Button size="xs" variant="ghost" disabled={offline} onClick={keepMine}>
              Keep my draft
            </Button>
          </>
        }
      >
        {statusKind.kind === "conflict"
          ? statusKind.message
          : "Your draft is based on an older revision."}
      </Alert>
    ) : null,
  ].filter((alert) => alert !== null);
  const yaml = (
    <div className="flex flex-col gap-3 p-4">
      {server !== null && server.definition === null ? (
        <Alert variant="error" title="This file is not a valid workflow">
          <ul className="flex flex-col gap-0.5">
            {server.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {compare !== null && draft !== null ? (
        <div className="grid gap-3 md:grid-cols-2" aria-label="Compare versions">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="wf-compare-server"
              className="text-xs font-medium text-muted-foreground"
            >
              Saved on server
              {compare.definition ? ` · revision ${compare.definition.revision}` : ""}
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
      ) : importing ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="wf-import" className="text-xs font-medium text-muted-foreground">
            {server?.definition === null ? "Repair YAML" : "Import YAML"}
          </label>
          {server !== null && !server.lossless ? (
            <Badge variant="warning">Protected values hidden · re-enter before replacing</Badge>
          ) : null}
          <Textarea
            id="wf-import"
            ariaLabel="Workflow YAML to import"
            rows={14}
            value={importText}
            onChange={setImportText}
          />
          {importError === null ? null : (
            <Alert variant="error" title="Not imported · current draft unchanged">
              {importError}
            </Alert>
          )}
          {candidate === null ? (
            <div className="flex flex-wrap justify-end gap-2">
              {draft === null ? null : (
                <Button variant="ghost" onClick={() => setImporting(false)}>
                  Cancel
                </Button>
              )}
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
            </div>
          ) : (
            <Alert
              variant="info"
              title={`“${candidate.title}” · ${candidate.nodes.length} steps`}
              actions={
                <>
                  <Button size="xs" variant="ghost" onClick={() => setCandidate(null)}>
                    Keep current draft
                  </Button>
                  <Button size="xs" onClick={() => adopt(candidate)}>
                    Replace draft with candidate
                  </Button>
                </>
              }
            >
              {base?.mode === "edit" && draft !== null && candidate.id !== draft.id
                ? `Keeps workflow ID ${draft.id}.`
                : null}
            </Alert>
          )}
        </div>
      ) : exported !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="wf-export" className="text-xs font-medium text-muted-foreground">
              Canonical YAML
            </label>
            {exported.protectedValues > 0 ? (
              <Badge variant="warning">
                {exported.protectedValues} protected{" "}
                {exported.protectedValues === 1 ? "value" : "values"} · restored only in this
                project
              </Badge>
            ) : null}
            <span className="ml-auto flex gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void navigator.clipboard?.writeText(exported.text)}
              >
                <CopyIcon />
                Copy
              </Button>
              {readOnly ? null : (
                <Button size="xs" variant="ghost" onClick={openImport}>
                  <UploadIcon />
                  Import
                </Button>
              )}
            </span>
          </div>
          <Textarea
            id="wf-export"
            ariaLabel="Exported workflow YAML"
            rows={18}
            readOnly
            value={exported.text}
            onChange={() => {}}
          />
        </div>
      ) : null}
    </div>
  );
  const views = [
    ...(canvasSupported() ? [{ value: "graph", label: "Graph" }] : []),
    { value: "routes", label: "Routes" },
    { value: "yaml", label: "YAML" },
  ];
  return (
    <>
      <PageHeader breadcrumb={breadcrumb(draft?.title || server?.source || "Workflow")}>
        <span role="status" aria-live="polite" className="flex items-center gap-1.5">
          {statusBadge}
          {draft !== null &&
          locallyValid &&
          !authoritative &&
          !offline &&
          validationUnavailable === null ? (
            <span className="max-sm:hidden">
              <Badge variant="outline">Checking…</Badge>
            </span>
          ) : null}
          {!offline && !saveAllowed && !readOnly ? (
            <Badge variant="secondary">View only</Badge>
          ) : null}
        </span>
        {draft !== null && problems.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={showProblems}>
            <CircleAlertIcon />
            {errors > 0
              ? `${errors} to fix`
              : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`}
          </Button>
        ) : null}
        <Menu
          ariaLabel="More workflow actions"
          items={[
            ...(readOnly
              ? []
              : [{ label: "Import YAML", icon: <UploadIcon />, onSelect: openImport }]),
            ...(draft === null
              ? []
              : [
                  {
                    label: "Export YAML",
                    icon: <FileCodeIcon />,
                    onSelect: () => {
                      setImporting(false);
                      setView("yaml");
                    },
                  },
                ]),
            ...(dirty && base?.mode !== "new"
              ? [
                  {
                    label: "Discard changes",
                    icon: <Undo2Icon />,
                    destructive: true,
                    onSelect: discard,
                  },
                ]
              : []),
          ]}
        />
        {readOnly ? (
          <Button size="sm" disabled={offline} onClick={clone}>
            Clone to edit
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={
              draft === null ||
              !dirty ||
              offline ||
              !saveAllowed ||
              blocking ||
              statusKind.kind === "saving"
            }
            onClick={save}
          >
            {base?.mode === "replace" ? "Validate and replace file" : "Save"}
          </Button>
        )}
      </PageHeader>
      <props.NavigationGuard
        when={dirty}
        title="Leave with unsaved workflow changes?"
        description={
          storageFailed
            ? "This draft could not be kept on this device."
            : "The draft stays on this device until you save or discard it."
        }
        onDiscard={forget}
        {...(storageFailed ? {} : { keepLabel: "Leave and keep draft" })}
        protectReload={storageFailed || base?.mode === "new"}
      />
      <div className="flex min-h-0 flex-1">
        {narrow || readOnly || draft === null ? null : (
          <aside className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-2">
            <h2 className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">Add step</h2>
            {palette}
          </aside>
        )}
        <section aria-label="Flow" className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
            <SegmentedControl
              ariaLabel="Workflow view"
              value={view}
              options={draft === null ? views.filter((item) => item.value === "yaml") : views}
              onChange={(value) => setView(value as View)}
            />
            {narrow && draft !== null ? (
              <span className="ml-auto flex gap-1">
                {readOnly ? null : (
                  <Button size="xs" variant="ghost" onClick={() => setPaletteOpen(true)}>
                    <PlusIcon />
                    Add a step
                  </Button>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel={selected === null ? "Workflow settings" : "Inspector"}
                  tooltip={selected === null ? "Workflow settings" : "Inspector"}
                  onClick={() => setInspectorOpen(true)}
                >
                  <PanelRightIcon />
                </Button>
              </span>
            ) : null}
          </div>
          {alerts.length === 0 ? null : (
            <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3">{alerts}</div>
          )}
          {draft === null && (view !== "yaml" || server === null) ? (
            readError === null && !offline ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">
                Loading workflow…
              </p>
            ) : null
          ) : view === "graph" && draft !== null ? (
            <div className="relative min-h-0 flex-1">
              <Graph
                definition={draft}
                selected={selected}
                problems={problems}
                readOnly={readOnly}
                onSelect={select}
                onRemove={removeSelected}
              />
            </div>
          ) : view === "routes" && draft !== null ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <RouteList
                props={props}
                definition={draft}
                selected={selected}
                problems={problems}
                readOnly={readOnly}
                onSelect={(id) => select(selected === id ? null : id)}
                onMove={(id, offset) => change(moveStep(draft, id, offset))}
                onRemove={removeSelected}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">{yaml}</div>
          )}
        </section>
        {narrow || draft === null ? null : (
          <aside
            aria-labelledby="wf-inspector-title"
            className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card/40 p-4"
          >
            {inspector}
          </aside>
        )}
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
          <props.Sheet
            open={inspectorOpen}
            onOpenChange={setInspectorOpen}
            title={selected === null ? "Workflow settings" : "Inspector"}
          >
            {inspector}
          </props.Sheet>
        </>
      ) : null}
    </>
  );
}
