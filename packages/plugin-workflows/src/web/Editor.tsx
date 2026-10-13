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
  editableKinds,
  problemText,
  removeStep,
  sameDefinition,
  slug,
  stepTitle,
  type EditableKind,
} from "./editing.ts";
import { Palette, stepButtonId } from "./Flow.tsx";
import { Graph } from "./Graph.tsx";
import { Inspector, controlId } from "./Inspector.tsx";

type View = "graph" | "yaml";

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
  // A save that gives a new workflow its file reopens the editor there; the step stays selected.
  const [selected, setSelected] = useState<string | null>(pageState.step ?? null);
  const [statusKind, setStatus] = useState<Status>({ kind: "idle" });
  // Freeze mutations synchronously, including handlers captured before the saving render.
  const saving = useRef(false);
  // Reads may finish after typing or even after a later save settles. Only the current
  // draft operation may replace the draft or advance its conflict/recovery baseline.
  const editVersion = useRef(0);
  // Background reads still supply metadata during typing, but baseline operations
  // supersede them. Save settlement also invalidates reads begun while saving.
  const baselineVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    remove: false,
  });
  const [view, setView] = useState<View>(() =>
    pageState.import === "1" || pageState.view === "yaml" ? "yaml" : "graph",
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
    const version = baselineVersion.current;
    const isCurrent = () => active && baselineVersion.current === version && !saving.current;
    setReadError(null);
    client.read({ projectId, source }).then(
      (entry) => {
        if (!isCurrent()) return;
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
        if (isCurrent()) setReadError(errorMessage(cause));
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
  const mutationsDisabled = readOnly || statusKind.kind === "saving";
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
        {
          pageId: "workflows.editor",
          projectId,
          state: { source: savedSource, ...(selected === null ? {} : { step: selected }) },
        },
        { replace: true },
      );
  }, [savedSource, dirty, projectId, source, selected, props]);

  const change = (next: Definition) => {
    if (readOnly || saving.current) return;
    editVersion.current++;
    setDraft(next);
  };
  // Stable so the graph's memoized handlers survive edits.
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  });
  const moveSelected = useCallback(
    (id: string, offset: -1 | 1) => {
      const current = latestDraft.current;
      if (readOnly || saving.current || current === null) return;
      const next = moveStep(current, id, offset);
      if (next === current) return;
      editVersion.current++;
      setDraft(next);
    },
    [readOnly],
  );
  const { notify } = props;
  const removeSelected = useCallback(
    (id: string) => {
      const current = latestDraft.current;
      if (readOnly || saving.current || current === null) return;
      editVersion.current++;
      const next = removeStep(current, id);
      setDraft(next);
      setSelected((now) => (now === id || now?.startsWith(`${id}/`) ? null : now));
      // The Start moves with its step's successor; say so instead of moving it silently.
      if (current.entry === id)
        notify(
          next.nodes.some((node) => node.id === next.entry)
            ? `Start moved to ${stepTitle(next)(next.entry)}`
            : "Start step removed · choose a new one",
          next.nodes.some((node) => node.id === next.entry) ? "success" : "warning",
        );
    },
    [readOnly, notify],
  );
  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (narrow && id !== null) setInspectorOpen(true);
    },
    [narrow],
  );
  // Leaving the import pane drops its text, error and preview so reopening starts clean.
  const closeImport = () => {
    setImporting(false);
    setImportText("");
    setImportError(null);
    setCandidate(null);
  };
  const discard = () => {
    if (saving.current) return;
    editVersion.current++;
    baselineVersion.current++;
    if (server === null) setReadAttempt((value) => value + 1);
    forget();
    setDraft(server?.definition ?? null);
    setBase(server === null ? null : baseOf(server));
    setStatus({ kind: "idle" });
    setCandidate(null);
  };
  const reload = () => {
    if (saving.current || projectId === null || source === null) return;
    const version = ++editVersion.current;
    baselineVersion.current++;
    client.read({ projectId, source }).then(
      (entry) => {
        if (editVersion.current !== version || !mounted.current) return;
        editVersion.current++;
        baselineVersion.current++;
        forget();
        setServer(entry);
        setDraft(entry.definition);
        setBase(baseOf(entry));
        setCompare(null);
        setStatus({ kind: "idle" });
      },
      (cause: unknown) => {
        if (editVersion.current === version && mounted.current)
          setStatus({ kind: "failed", message: errorMessage(cause) });
      },
    );
  };
  const compareLatest = () => {
    if (saving.current || projectId === null || source === null) return;
    const version = editVersion.current;
    client.read({ projectId, source }).then(
      (entry) => {
        if (editVersion.current === version && mounted.current) setCompare(entry);
      },
      (cause: unknown) => {
        if (editVersion.current === version && mounted.current)
          setStatus({ kind: "failed", message: errorMessage(cause) });
      },
    );
  };
  const keepMine = () => {
    if (saving.current || projectId === null || source === null || base === null) return;
    const version = ++editVersion.current;
    baselineVersion.current++;
    client.read({ projectId, source }).then(
      (entry) => {
        if (editVersion.current !== version || !mounted.current) return;
        editVersion.current++;
        baselineVersion.current++;
        setServer(entry);
        setBase({
          ...baseOf(entry),
          mode: base.mode === "replace" ? "replace" : baseOf(entry).mode,
        });
        setStatus({ kind: "idle" });
      },
      (cause: unknown) => {
        if (editVersion.current === version && mounted.current)
          setStatus({ kind: "failed", message: errorMessage(cause) });
      },
    );
  };
  const save = () => {
    if (saving.current || draft === null || base === null || projectId === null) return;
    editVersion.current++;
    baselineVersion.current++;
    saving.current = true;
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
        if (!mounted.current) return;
        baselineVersion.current++;
        saving.current = false;
        forget();
        setServer(entry);
        setDraft(entry.definition);
        setBase(baseOf(entry));
        setStatus({ kind: "idle" });
        setSavedSource(entry.source);
      },
      (cause: unknown) => {
        if (!mounted.current) return;
        baselineVersion.current++;
        saving.current = false;
        // A recovered draft may be saved before its initial read returns. On failure,
        // replace the superseded read so identity and conflict metadata can still load.
        if (server === null) setReadAttempt((value) => value + 1);
        setStatus(
          errorCode(cause) === "conflict"
            ? { kind: "conflict", message: errorMessage(cause) }
            : { kind: "failed", message: errorMessage(cause) },
        );
      },
    );
  };
  const adopt = (definition: Definition) => {
    if (readOnly || saving.current) return;
    editVersion.current++;
    baselineVersion.current++;
    if (server === null) setReadAttempt((value) => value + 1);
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
    closeImport();
    setView("graph");
    setSelected(null);
  };
  const clone = () => {
    if (draft === null || projectId === null) return;
    const original = draft;
    void unusedWorkflowId(client, props.drafts, projectId, slug(`${original.id}-copy`)).then(
      (id) => {
        const workflowKey = `new:${id}:${Date.now().toString(36)}`;
        const kept = writeDraft(props.drafts, draftKey(projectId, workflowKey), {
          version: 1,
          base: { mode: "new", source: null, fingerprint: null, revision: null },
          definition: { ...original, id, title: `${original.title} (copy)`, revision: 1 },
          updatedAt: Date.now(),
        });
        if (!kept) {
          setStatus({
            kind: "failed",
            message: "This browser could not keep a local draft. Free some site storage.",
          });
          return;
        }
        props.navigate({ pageId: "workflows.editor", projectId, state: { draft: workflowKey } });
      },
      (cause: unknown) => setStatus({ kind: "failed", message: errorMessage(cause) }),
    );
  };
  const goTo = (problem: Problem) => {
    setSelected(problem.nodeId ?? null);
    if (view === "yaml" && problem.nodeId !== undefined) setView("graph");
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
        <Badge variant={base?.revision != null ? "success" : "secondary"}>
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
    if (saving.current) return;
    setCompare(null);
    setImporting(true);
    setView("yaml");
  };
  const selectedKind = draft?.nodes.find((node) => node.id === selected)?.kind;
  const selectedRemovable =
    !mutationsDisabled &&
    draft !== null &&
    draft.nodes.length > 1 &&
    selectedKind !== undefined &&
    (editableKinds as ReadonlyArray<string>).includes(selectedKind);
  const inspectorPanel = (inSheet: boolean) =>
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
                    {problemText(problem, stepTitle(draft))}
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
          readOnly={mutationsDisabled}
          identityEditable={base?.mode !== "edit"}
          onChange={change}
          {...(selectedRemovable ? { onRemove: removeSelected } : {})}
          hideHeading={inSheet && selected === null}
        />
      </div>
    );
  const palette =
    draft === null ? null : (
      <Palette
        props={props}
        capabilities={capabilities}
        disabled={mutationsDisabled}
        onAdd={(kind: EditableKind) => {
          if (saving.current) return;
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
        title={readOnly ? "Not cloned" : "Not saved · edits kept"}
        actions={
          readOnly ? (
            <Button size="xs" variant="outline" onClick={libraryLink}>
              Open library
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={offline || blocking} onClick={save}>
              Retry save
            </Button>
          )
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
              if (saving.current) return;
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
        title="Changed on the server"
        actions={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={offline || mutationsDisabled}
              onClick={() => {
                compareLatest();
                setView("yaml");
                closeImport();
              }}
            >
              Compare
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={offline || mutationsDisabled}
              onClick={reload}
            >
              Reload
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={offline || mutationsDisabled}
              onClick={keepMine}
            >
              Keep my draft
            </Button>
          </>
        }
      />
    ) : null,
  ].filter((alert) => alert !== null);
  const yaml = (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
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
        <div
          className="grid min-h-0 flex-1 gap-3 md:grid-cols-2 md:grid-rows-[minmax(0,1fr)_auto]"
          aria-label="Compare versions"
        >
          <div className="flex min-h-64 flex-col gap-1.5">
            <label
              htmlFor="wf-compare-server"
              className="text-xs font-medium text-muted-foreground"
            >
              Saved on server
              {compare.definition ? ` · revision ${compare.definition.revision}` : ""}
            </label>
            <Textarea
              id="wf-compare-server"
              variant="code"
              readOnly
              value={compare.text}
              onChange={() => {}}
            />
          </div>
          <div className="flex min-h-64 flex-col gap-1.5">
            <label htmlFor="wf-compare-draft" className="text-xs font-medium text-muted-foreground">
              Your draft
            </label>
            <Textarea
              id="wf-compare-draft"
              variant="code"
              readOnly
              value={exportYaml(draft).text}
              onChange={() => {}}
            />
          </div>
          <div>
            <Button size="xs" variant="outline" onClick={() => setCompare(null)}>
              Close comparison
            </Button>
          </div>
        </div>
      ) : importing ? (
        <div className="flex min-h-64 flex-1 flex-col gap-2">
          <label htmlFor="wf-import" className="text-xs font-medium text-muted-foreground">
            {server?.definition === null ? "Repair YAML" : "Import YAML"}
          </label>
          {server !== null && !server.lossless ? (
            <Badge variant="warning">Protected values hidden · re-enter before replacing</Badge>
          ) : null}
          <Textarea
            id="wf-import"
            ariaLabel="Workflow YAML to import"
            variant="code"
            value={importText}
            disabled={mutationsDisabled}
            onChange={(text) => {
              if (!saving.current) setImportText(text);
            }}
          />
          {importError === null ? null : (
            <Alert variant="error" title="Not imported · current draft unchanged">
              {importError}
            </Alert>
          )}
          {candidate === null ? (
            <div className="flex flex-wrap justify-end gap-2">
              {draft === null ? null : (
                <Button variant="ghost" onClick={closeImport}>
                  Cancel
                </Button>
              )}
              <Button
                disabled={mutationsDisabled || !importText.trim()}
                onClick={() => {
                  if (saving.current) return;
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
                Preview import
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
                  <Button size="xs" disabled={mutationsDisabled} onClick={() => adopt(candidate)}>
                    Replace draft
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
        <div className="flex min-h-64 flex-1 flex-col gap-2">
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
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(exported.text)
                    .then(() => notify("YAML copied"))
                }
              >
                <CopyIcon />
                Copy
              </Button>
              {readOnly ? null : (
                <Button size="xs" variant="ghost" disabled={mutationsDisabled} onClick={openImport}>
                  <UploadIcon />
                  Import
                </Button>
              )}
            </span>
          </div>
          <Textarea
            id="wf-export"
            ariaLabel="Exported workflow YAML"
            variant="code"
            readOnly
            value={exported.text}
            onChange={() => {}}
          />
        </div>
      ) : null}
    </div>
  );
  // The header keeps the title's room at narrow widths: icon and count, full words in the tooltip.
  const problemsLabel =
    errors > 0 ? `${errors} to fix` : `${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
  const views = [
    { value: "graph", label: "Graph" },
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
              <Badge variant="secondary">Checking…</Badge>
            </span>
          ) : null}
          {!offline && !saveAllowed && !readOnly ? (
            <Badge variant="secondary">View only</Badge>
          ) : null}
        </span>
        {draft !== null && problems.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={showProblems}
            {...(narrow ? { tooltip: problemsLabel, ariaLabel: problemsLabel } : {})}
          >
            <CircleAlertIcon />
            {narrow ? (errors > 0 ? errors : warnings) : problemsLabel}
          </Button>
        ) : null}
        <Menu
          ariaLabel="More workflow actions"
          items={[
            ...(readOnly
              ? []
              : [
                  {
                    label: "Import YAML",
                    icon: <UploadIcon />,
                    disabled: mutationsDisabled,
                    onSelect: openImport,
                  },
                ]),
            ...(draft === null
              ? []
              : [
                  {
                    label: "Export YAML",
                    icon: <FileCodeIcon />,
                    onSelect: () => {
                      closeImport();
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
                    disabled: mutationsDisabled,
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
        {...(statusKind.kind === "saving"
          ? {
              description: storageFailed
                ? "Saving is still in progress. This draft could not be kept on this device."
                : "Saving is still in progress. Your recovery draft is kept if you leave.",
            }
          : storageFailed
            ? { description: "This draft could not be kept on this device." }
            : {})}
        onDiscard={() => {
          // Leaving during a request keeps recovery data; an unmounted response cannot erase it.
          if (!saving.current) {
            editVersion.current++;
            baselineVersion.current++;
            forget();
          }
        }}
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
        <section aria-label="Flow" className="relative flex min-w-0 flex-1 flex-col">
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
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={mutationsDisabled}
                    onClick={() => {
                      setInspectorOpen(false);
                      setPaletteOpen(true);
                    }}
                  >
                    <PlusIcon />
                    Add a step
                  </Button>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel={selected === null ? "Workflow settings" : "Inspector"}
                  tooltip={selected === null ? "Workflow settings" : "Inspector"}
                  onClick={() => {
                    setPaletteOpen(false);
                    setInspectorOpen(true);
                  }}
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
                readOnly={mutationsDisabled}
                onSelect={select}
                onMove={moveSelected}
                onRemove={removeSelected}
                Tooltip={props.Tooltip}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{yaml}</div>
          )}
        </section>
        {narrow || draft === null ? null : (
          <aside
            aria-labelledby="wf-inspector-title"
            className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card/40 p-4"
          >
            {inspectorPanel(false)}
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
            {inspectorPanel(true)}
          </props.Sheet>
        </>
      ) : null}
    </>
  );
}
