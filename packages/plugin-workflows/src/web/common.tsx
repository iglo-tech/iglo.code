import type { PluginDraftStore, PluginWebContext } from "@t3tools/plugin-host-contract/web";
import type { ProjectId } from "@t3tools/plugin-host-contract/schema";
import { useEffect, useState, type ReactNode } from "react";
import type { Definition, ProjectSummary, WorkflowClient } from "../contracts.ts";
import { isDefinitionLike } from "./editing.ts";

export type PageProps = PluginWebContext & { readonly client: WorkflowClient };

export function errorMessage(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The request failed. Check the connection to this environment and try again.";
}
export function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  if ((cause as { _tag?: unknown })._tag === "EnvironmentAuthorizationError") return "unauthorized";
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Narrow layouts move the palette and inspector into labeled sheets. */
const narrowQuery = () =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia("(max-width: 1023px)");
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => narrowQuery()?.matches ?? false);
  useEffect(() => {
    const query = narrowQuery();
    if (query === null) return;
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function Labeled({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint === undefined || hint === null || hint === false ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Shows where work runs and lets the user switch project within this environment only. */
export function TargetBar({
  props,
  projects,
  projectsError,
  onRetry,
}: {
  readonly props: PageProps;
  readonly projects: ReadonlyArray<ProjectSummary> | null;
  readonly projectsError: string | null;
  readonly onRetry: () => void;
}) {
  const { Select, Button, Badge, environmentLabel, projectId, connection } = props;
  const current = projects?.find((project) => project.id === projectId);
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm" aria-label="Workflow target">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Environment</span>
        <span className="flex items-center gap-2">
          <span className="font-medium">{environmentLabel}</span>
          {connection === "disconnected" ? <Badge variant="warning">Disconnected</Badge> : null}
        </span>
      </div>
      <div className="flex min-w-48 flex-col gap-1">
        <label htmlFor="workflow-project" className="text-xs font-medium text-muted-foreground">
          Project
        </label>
        {projects === null ? (
          <span className="text-muted-foreground">
            {projectsError ?? (projectId === null ? "Loading projects…" : projectId)}
          </span>
        ) : (
          <Select
            id="workflow-project"
            ariaLabel="Project"
            disabled={connection === "disconnected"}
            value={projectId ?? ""}
            onChange={(value) =>
              props.navigate({
                pageId: "workflows.library",
                ...(value === "" ? {} : { projectId: value as ProjectId }),
              })
            }
            options={[
              ...(projectId === null || current === undefined
                ? [
                    {
                      value: projectId ?? "",
                      label: projectId ?? "Choose a project",
                      disabled: true,
                    },
                  ]
                : []),
              ...projects.map((project) => ({ value: project.id, label: project.title })),
            ]}
          />
        )}
      </div>
      {projectsError === null ? null : (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function useProjects(props: PageProps) {
  const [projects, setProjects] = useState<ReadonlyArray<ProjectSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { client, connection } = props;
  useEffect(() => {
    if (connection === "disconnected") return;
    let active = true;
    setError(null);
    client.projects().then(
      (value) => {
        if (active) setProjects(value);
      },
      (cause: unknown) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [client, connection, attempt]);
  return { projects, error, retry: () => setAttempt((value) => value + 1) };
}

/** What a local draft is based on; it is editing state, never execution state. */
export interface DraftBase {
  readonly mode: "new" | "edit" | "replace";
  readonly source: string | null;
  readonly fingerprint: string | null;
  readonly revision: number | null;
}
export interface DraftEnvelope {
  readonly version: 1;
  readonly base: DraftBase;
  readonly definition: Definition;
  readonly updatedAt: number;
}
/** Drafts are keyed by project and workflow inside the host's environment/plugin scope. */
export const draftKey = (projectId: ProjectId, workflow: string) => `${projectId}:${workflow}`;
export function readDraft(store: PluginDraftStore, key: string): DraftEnvelope | null {
  const raw = store.read(key);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const envelope = value as Partial<DraftEnvelope>;
    return envelope.version === 1 &&
      typeof envelope.base === "object" &&
      envelope.base !== null &&
      isDefinitionLike(envelope.definition)
      ? (envelope as DraftEnvelope)
      : null;
  } catch {
    return null;
  }
}
export function writeDraft(store: PluginDraftStore, key: string, envelope: DraftEnvelope) {
  return store.write(key, JSON.stringify(envelope));
}

/** Local drafts for one project, newest last, with where each one reopens. */
export function projectDrafts(store: PluginDraftStore, projectId: ProjectId) {
  const prefix = `${projectId}:`;
  return store.keys().flatMap((key) => {
    if (!key.startsWith(prefix)) return [];
    const envelope = readDraft(store, key);
    if (envelope === null) return [];
    const workflow = key.slice(prefix.length);
    return [
      {
        key,
        title: envelope.definition.title || envelope.definition.id,
        state: workflow.startsWith("new:") ? { draft: workflow } : { source: workflow },
        isNew: workflow.startsWith("new:"),
      },
    ];
  });
}

/** An identity not used by the catalog or a local draft: `base`, then `base-2`, `base-3`… */
export async function unusedWorkflowId(
  client: WorkflowClient,
  store: PluginDraftStore,
  projectId: ProjectId,
  base: string,
): Promise<string> {
  const page = await client.library({ projectId, query: base, limit: 50 });
  const used = new Set([
    // Saving a new workflow writes `<id>.yaml`, so authored file names (including invalid
    // files with no readable identity) are taken too.
    ...page.entries.flatMap((entry) => [
      ...(entry.definitionId === null ? [] : [entry.definitionId]),
      ...(entry.packaged ? [] : [(entry.source.split("/").at(-1) ?? "").replace(/\.ya?ml$/, "")]),
    ]),
    ...projectDrafts(store, projectId).flatMap(
      (draft) => readDraft(store, draft.key)?.definition.id ?? [],
    ),
  ]);
  for (let index = 1; ; index++) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}
