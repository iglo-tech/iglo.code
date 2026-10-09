import { Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderInstanceId, RuntimeMode } from "@t3tools/plugin-host-contract/schema";
import type { Capabilities, Definition, Field, Node, Problem, Route, Skill } from "../contracts.ts";
import { Labeled, errorMessage, type PageProps } from "./common.tsx";
import { isProtected, kindLabels, routeList, updateNode, upstreamFields } from "./editing.ts";
import { KindIcon } from "./kinds.tsx";

type AgentNode = Extract<Node, { kind: "agent" }>;
const runtimeModes: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const runtimeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Ask before external actions",
  "auto-accept-edits": "Accept edits automatically",
  auto: "Automatic",
  "full-access": "Full access",
};
export const controlId = (nodeId: string | null, control: string) =>
  `wf-${nodeId ?? "workflow"}-${control.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
/** An empty control matches the node's own problems that name no specific control. */
const matches = (problem: Problem, nodeId: string | null, control: string) =>
  (problem.nodeId ?? null) === nodeId &&
  (control === ""
    ? problem.control === undefined
    : problem.control !== undefined &&
      (problem.control === control || problem.control.startsWith(`${control}.`)));
const minutes = (value: number | undefined) =>
  value === undefined ? "" : String(Math.round(value / 60_000));

interface InspectorProps {
  readonly props: PageProps;
  readonly definition: Definition;
  readonly selected: string | null;
  readonly capabilities: Capabilities | null;
  readonly capabilitiesError: string | null;
  readonly onRetryCapabilities: () => void;
  readonly problems: ReadonlyArray<Problem>;
  readonly readOnly: boolean;
  readonly identityEditable: boolean;
  readonly onChange: (definition: Definition) => void;
}

export function Inspector(input: InspectorProps) {
  const node = input.definition.nodes.find((item) => item.id === input.selected);
  return (
    <section aria-labelledby="wf-inspector-title" className="flex min-w-0 flex-col gap-4">
      <h2 id="wf-inspector-title" className="flex items-center gap-2 text-sm font-medium">
        {node === undefined ? null : (
          <KindIcon kind={node.kind} className="size-4 text-muted-foreground" />
        )}
        {node === undefined ? "Workflow settings" : kindLabels[node.kind]}
      </h2>
      {node === undefined ? (
        <WorkflowSettings {...input} />
      ) : node.kind === "agent" ? (
        <AgentInspector key={node.id} {...input} node={node} />
      ) : node.kind === "end" ? (
        <EndInspector key={node.id} {...input} node={node} />
      ) : (
        <ReadOnlyStep {...input} node={node} />
      )}
    </section>
  );
}

function Problems({
  problems,
  nodeId,
  control,
}: {
  readonly problems: ReadonlyArray<Problem>;
  readonly nodeId: string | null;
  readonly control: string;
}) {
  const found = problems.filter((problem) => matches(problem, nodeId, control));
  if (found.length === 0) return null;
  return (
    <ul id={`${controlId(nodeId, control)}-problems`} className="text-xs">
      {found.map((problem, index) => (
        <li
          key={index}
          className={problem.severity === "error" ? "text-destructive" : "text-warning-foreground"}
        >
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

function nodeOptions(definition: Definition, filter: (node: Node) => boolean = () => true) {
  return definition.nodes.filter(filter).map((node) => ({
    value: node.id,
    label: `${node.title || node.id} (${kindLabels[node.kind]})`,
  }));
}
function withCurrent(
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>,
  current: string,
  label: string,
) {
  return current === "" || options.some((option) => option.value === current)
    ? options
    : [{ value: current, label }, ...options];
}

function WorkflowSettings({
  props,
  definition,
  problems,
  readOnly,
  identityEditable,
  onChange,
}: InspectorProps) {
  const { Input, Select } = props;
  const terminal = nodeOptions(definition, (node) => node.kind === "end" || node.kind === "human");
  const invalid = (control: string) => problems.some((problem) => matches(problem, null, control));
  return (
    <div className="flex flex-col gap-3">
      <Labeled id={controlId(null, "title")} label="Name">
        <Input
          id={controlId(null, "title")}
          value={definition.title}
          readOnly={readOnly}
          invalid={invalid("title")}
          onChange={(title) => onChange({ ...definition, title })}
        />
      </Labeled>
      <Problems problems={problems} nodeId={null} control="title" />
      <Labeled id={controlId(null, "id")} label="Workflow ID">
        <Input
          id={controlId(null, "id")}
          value={definition.id}
          readOnly={readOnly || !identityEditable}
          invalid={invalid("id")}
          onChange={(id) => onChange({ ...definition, id })}
        />
      </Labeled>
      <Problems problems={problems} nodeId={null} control="id" />
      <Labeled id={controlId(null, "entry")} label="Start at">
        <Select
          id={controlId(null, "entry")}
          value={definition.entry}
          disabled={readOnly}
          invalid={invalid("entry")}
          options={withCurrent(
            nodeOptions(definition),
            definition.entry,
            `${definition.entry} (missing)`,
          )}
          onChange={(entry) => onChange({ ...definition, entry })}
        />
      </Labeled>
      <Problems problems={problems} nodeId={null} control="entry" />
      <Labeled id={controlId(null, "maxVisits")} label="Run visit limit">
        <Input
          id={controlId(null, "maxVisits")}
          type="number"
          placeholder="100"
          value={definition.maxVisits === undefined ? "" : String(definition.maxVisits)}
          readOnly={readOnly}
          onChange={(value) => {
            const { maxVisits: _previous, ...rest } = definition;
            const parsed = Number.parseInt(value, 10);
            onChange(Number.isFinite(parsed) ? { ...rest, maxVisits: parsed } : rest);
          }}
        />
      </Labeled>
      <Labeled id={controlId(null, "atLimit")} label="At limit">
        <Select
          id={controlId(null, "atLimit")}
          value={definition.atLimit}
          disabled={readOnly}
          invalid={invalid("atLimit")}
          options={withCurrent(terminal, definition.atLimit, `${definition.atLimit} (not an end)`)}
          onChange={(atLimit) => onChange({ ...definition, atLimit })}
        />
      </Labeled>
      <Problems problems={problems} nodeId={null} control="atLimit" />
    </div>
  );
}

function RouteSelect({
  props,
  definition,
  node,
  control,
  label,
  route,
  optional,
  readOnly,
  problems,
  onRoute,
}: {
  readonly props: PageProps;
  readonly definition: Definition;
  readonly node: Node;
  readonly control: string;
  readonly label: string;
  readonly route: Route | undefined;
  readonly optional: boolean;
  readonly readOnly: boolean;
  readonly problems: ReadonlyArray<Problem>;
  readonly onRoute: (route: Route | undefined) => void;
}) {
  const id = controlId(node.id, control);
  const target = (to: string) => definition.nodes.find((item) => item.id === to)?.title ?? to;
  return (
    <>
      <Labeled
        id={id}
        label={label}
        hint={
          route?.repeat
            ? `Repeat ×${route.repeat.max} · at limit → ${target(route.repeat.atLimit)}`
            : null
        }
      >
        <props.Select
          id={id}
          value={route?.to ?? ""}
          disabled={readOnly || route?.repeat !== undefined}
          invalid={problems.some((problem) => matches(problem, node.id, control))}
          options={withCurrent(
            [...(optional ? [{ value: "", label: "Not set" }] : []), ...nodeOptions(definition)],
            route?.to ?? "",
            `${route?.to ?? ""} (missing)`,
          )}
          onChange={(to) => onRoute(to === "" ? undefined : { to })}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control={control} />
    </>
  );
}

function EndInspector({
  props,
  definition,
  node,
  problems,
  readOnly,
  onChange,
}: InspectorProps & { readonly node: Extract<Node, { kind: "end" }> }) {
  const set = (update: Partial<Extract<Node, { kind: "end" }>>) =>
    onChange(updateNode(definition, node.id, (current) => ({ ...current, ...update }) as Node));
  return (
    <div className="flex flex-col gap-3">
      <Labeled id={controlId(node.id, "title")} label="Label">
        <props.Input
          id={controlId(node.id, "title")}
          value={node.title}
          readOnly={readOnly}
          onChange={(title) => set({ title })}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="title" />
      <Labeled id={controlId(node.id, "outcome")} label="Outcome">
        <props.Select
          id={controlId(node.id, "outcome")}
          value={node.outcome}
          disabled={readOnly}
          options={[
            { value: "completed", label: "Completed" },
            { value: "failed", label: "Failed" },
            { value: "unresolved", label: "Unresolved" },
          ]}
          onChange={(outcome) => set({ outcome: outcome as typeof node.outcome })}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="" />
    </div>
  );
}

/** Kinds authored in later updates are shown with their routes and kept exactly on save. */
function ReadOnlyStep({
  props,
  definition,
  node,
  problems,
}: InspectorProps & { readonly node: Node }) {
  const target = (id: string) => definition.nodes.find((item) => item.id === id)?.title ?? id;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium">{node.title}</span>
        <props.Badge variant="secondary">Read-only</props.Badge>
      </div>
      <ul aria-label="Routes" className="flex flex-col gap-1 text-xs text-muted-foreground">
        {routeList(definition)
          .filter((route) => route.from.id === node.id)
          .map((route) => (
            <li key={route.control}>
              {route.label} → {target(route.to)}
              {route.repeat
                ? ` · repeat ×${route.repeat.max}, at limit → ${target(route.repeat.atLimit)}`
                : ""}
            </li>
          ))}
      </ul>
      <Problems problems={problems} nodeId={node.id} control="" />
    </div>
  );
}

function AgentInspector({
  props,
  definition,
  node,
  capabilities,
  capabilitiesError,
  onRetryCapabilities,
  problems,
  readOnly,
  onChange,
}: InspectorProps & { readonly node: AgentNode }) {
  const { Input, Select, Textarea, Button, client, projectId, connection } = props;
  const set = (update: (current: AgentNode) => AgentNode) =>
    onChange(updateNode(definition, node.id, (current) => update(current as AgentNode)));
  const invalid = (control: string) =>
    problems.some((problem) => matches(problem, node.id, control));
  const providers = capabilities?.providers ?? [];
  const provider = providers.find((item) => item.instanceId === node.modelSelection.instanceId);
  const model = provider?.models.find((item) => item.slug === node.modelSelection.model);
  const [skills, setSkills] = useState<ReadonlyArray<Skill> | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsAttempt, setSkillsAttempt] = useState(0);
  const instanceId = node.modelSelection.instanceId;
  useEffect(() => {
    if (projectId === null || connection === "disconnected") return;
    let active = true;
    setSkills(null);
    setSkillsError(null);
    client.skills({ projectId, providerInstanceId: instanceId }).then(
      (value) => {
        if (active) setSkills(value);
      },
      (cause: unknown) => {
        if (active) setSkillsError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId, connection, instanceId, skillsAttempt]);
  const upstream = upstreamFields(definition, node.id);
  const field = (index: number, update: Partial<Field>) =>
    set((current) => ({
      ...current,
      report: {
        ...current.report,
        fields: current.report.fields.map((item, position) => {
          if (position !== index) return item;
          const next = { ...item, ...update };
          if (next.type !== "enum") {
            const { values: _values, ...rest } = next;
            return rest;
          }
          return { ...next, values: next.values ?? [] };
        }),
      },
    }));
  const optionValue = (id: string) =>
    node.modelSelection.options?.find((option) => option.id === id)?.value;
  const setOption = (id: string, value: string | boolean | undefined) =>
    set((current) => {
      const options = (current.modelSelection.options ?? []).filter((option) => option.id !== id);
      const next = value === undefined ? options : [...options, { id, value }];
      const { options: _previous, ...selection } = current.modelSelection;
      return {
        ...current,
        modelSelection: next.length === 0 ? selection : { ...selection, options: next },
      };
    });
  const protectedNote = (value: string) =>
    isProtected(value) ? "Protected value · kept on save unless replaced" : null;
  const timeout = (key: "timeoutMs" | "humanTimeoutMs", value: string) =>
    set((current) => {
      const { [key]: _previous, ...rest } = current;
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? { ...rest, [key]: Math.round(parsed * 60_000) } : rest;
    });
  const skillOptions = [
    { value: "", label: "No skill" },
    ...(skills ?? []).map((skill) => ({
      value: skill.name,
      label: `${skill.displayName ?? skill.name}${skill.enabled ? "" : " (disabled)"}`,
      disabled: !skill.enabled,
    })),
  ];
  return (
    <div className="flex flex-col gap-3">
      <Labeled id={controlId(node.id, "title")} label="Label">
        <Input
          id={controlId(node.id, "title")}
          value={node.title}
          readOnly={readOnly}
          invalid={invalid("title")}
          onChange={(title) => set((current) => ({ ...current, title }))}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="title" />
      {capabilitiesError !== null || capabilities?.discoveryError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>
            Provider discovery is unavailable: {capabilitiesError ?? capabilities?.discoveryError}
          </span>
          <Button
            size="sm"
            variant="outline"
            ariaLabel="Retry provider discovery"
            onClick={onRetryCapabilities}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <Labeled
        id={controlId(node.id, "modelSelection")}
        label="Provider"
        hint={
          provider === undefined
            ? capabilities === null
              ? "Loading providers…"
              : "Not configured in this environment. Choose another provider."
            : !provider.reporting
              ? `Cannot submit workflow reports: ${provider.reason ?? "unsupported"}.`
              : !provider.available
                ? `Not ready: ${provider.reason ?? "unavailable"}.`
                : null
        }
      >
        <Select
          id={controlId(node.id, "modelSelection")}
          value={node.modelSelection.instanceId}
          disabled={readOnly}
          invalid={invalid("modelSelection")}
          options={withCurrent(
            providers.map((item) => ({
              value: item.instanceId,
              label: `${item.displayName ?? item.instanceId}${
                item.reporting ? (item.available ? "" : " — not ready") : " — cannot report"
              }`,
            })),
            node.modelSelection.instanceId,
            `${node.modelSelection.instanceId} (not in this environment)`,
          )}
          onChange={(value) => {
            const next = providers.find((item) => item.instanceId === value);
            set((current) => ({
              ...current,
              modelSelection: {
                instanceId: value as ProviderInstanceId,
                model: next?.models[0]?.slug ?? current.modelSelection.model,
              },
              runtimeMode:
                next === undefined || next.runtimeModes.includes(current.runtimeMode)
                  ? current.runtimeMode
                  : (next.runtimeModes[0] ?? current.runtimeMode),
              ...(current.skill === undefined ? {} : { skill: current.skill }),
            }));
          }}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="modelSelection" />
      <Labeled id={controlId(node.id, "model")} label="Model">
        <Select
          id={controlId(node.id, "model")}
          value={node.modelSelection.model}
          disabled={readOnly}
          options={withCurrent(
            (provider?.models ?? []).map((item) => ({
              value: item.slug,
              label: `${item.name}${item.isCustom ? " (custom)" : ""}`,
            })),
            node.modelSelection.model,
            `${node.modelSelection.model} (not listed)`,
          )}
          onChange={(value) =>
            set((current) => ({
              ...current,
              modelSelection: { instanceId: current.modelSelection.instanceId, model: value },
            }))
          }
        />
      </Labeled>
      {(model?.optionDescriptors ?? []).map((descriptor) => {
        const id = controlId(node.id, `option-${descriptor.id}`);
        const value = optionValue(descriptor.id);
        return (
          <Labeled key={descriptor.id} id={id} label={descriptor.label}>
            <Select
              id={id}
              value={value === undefined ? "" : String(value)}
              disabled={readOnly}
              options={[
                { value: "", label: "Provider default" },
                ...(descriptor.type === "select"
                  ? descriptor.options.map((choice) => ({ value: choice.id, label: choice.label }))
                  : [
                      { value: "true", label: "On" },
                      { value: "false", label: "Off" },
                    ]),
              ]}
              onChange={(next) =>
                setOption(
                  descriptor.id,
                  next === "" ? undefined : descriptor.type === "boolean" ? next === "true" : next,
                )
              }
            />
          </Labeled>
        );
      })}
      <Labeled id={controlId(node.id, "runtimeMode")} label="Runtime mode">
        <Select
          id={controlId(node.id, "runtimeMode")}
          value={node.runtimeMode}
          disabled={readOnly}
          invalid={invalid("runtimeMode")}
          options={runtimeModes.map((mode) => ({
            value: mode,
            label: `${runtimeLabels[mode]}${
              provider !== undefined && !provider.runtimeModes.includes(mode)
                ? " — not supported"
                : ""
            }`,
          }))}
          onChange={(value) =>
            set((current) => ({ ...current, runtimeMode: value as RuntimeMode }))
          }
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="runtimeMode" />
      <Labeled id={controlId(node.id, "interactionMode")} label="Interaction mode">
        <Select
          id={controlId(node.id, "interactionMode")}
          value={node.interactionMode ?? "default"}
          disabled={readOnly}
          options={[
            { value: "default", label: "Default" },
            { value: "plan", label: "Plan" },
          ]}
          onChange={(value) =>
            set((current) => {
              const { interactionMode: _previous, ...rest } = current;
              return value === "plan" ? { ...rest, interactionMode: "plan" } : rest;
            })
          }
        />
      </Labeled>
      <Labeled
        id={controlId(node.id, "skill")}
        label="Installed skill"
        hint={
          skillsError !== null
            ? null
            : node.skill !== undefined &&
                skills !== null &&
                !skills.some((skill) => skill.name === node.skill && skill.enabled)
              ? `${node.skill} is not installed for this provider. Choose an installed skill.`
              : skills === null && connection === "connected"
                ? "Loading skills…"
                : null
        }
      >
        <Select
          id={controlId(node.id, "skill")}
          value={node.skill ?? ""}
          disabled={readOnly}
          invalid={invalid("skill")}
          options={withCurrent(
            skillOptions,
            node.skill ?? "",
            `${node.skill ?? ""} (not installed)`,
          )}
          onChange={(value) =>
            set((current) => {
              const { skill: _previous, ...rest } = current;
              return value === "" ? rest : { ...rest, skill: value };
            })
          }
        />
      </Labeled>
      {skillsError === null ? null : (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>Skill discovery failed: {skillsError}</span>
          <Button
            size="sm"
            variant="outline"
            ariaLabel="Retry skill discovery"
            onClick={() => setSkillsAttempt((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      <Problems problems={problems} nodeId={node.id} control="skill" />
      <Labeled
        id={controlId(node.id, "instruction")}
        label="Instructions"
        hint={protectedNote(node.instruction)}
      >
        <Textarea
          id={controlId(node.id, "instruction")}
          rows={6}
          value={node.instruction}
          readOnly={readOnly}
          invalid={invalid("instruction")}
          onChange={(instruction) => set((current) => ({ ...current, instruction }))}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="instruction" />
      <div className="grid grid-cols-2 gap-3">
        <Labeled id={controlId(node.id, "timeoutMs")} label="Deadline (min)">
          <Input
            id={controlId(node.id, "timeoutMs")}
            type="number"
            placeholder="120"
            value={minutes(node.timeoutMs)}
            readOnly={readOnly}
            invalid={invalid("timeoutMs")}
            onChange={(value) => timeout("timeoutMs", value)}
          />
        </Labeled>
        <Labeled id={controlId(node.id, "humanTimeoutMs")} label="Input deadline (min)">
          <Input
            id={controlId(node.id, "humanTimeoutMs")}
            type="number"
            value={minutes(node.humanTimeoutMs)}
            readOnly={readOnly}
            onChange={(value) => timeout("humanTimeoutMs", value)}
          />
        </Labeled>
      </div>
      <fieldset className="flex flex-col gap-2 border-t border-border pt-4">
        <legend className="pb-1 text-xs font-medium text-muted-foreground">Inputs</legend>
        {(node.bindings ?? []).map((binding, index) => {
          const id = controlId(node.id, `bindings.${index}`);
          const value = `${binding.node}\u0000${binding.path}`;
          return (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1">
                <Labeled id={id} label={`Input ${index + 1}`}>
                  <Select
                    id={id}
                    value={value}
                    disabled={readOnly}
                    invalid={invalid(`bindings.${index}`)}
                    options={withCurrent(
                      upstream.map((item) => ({
                        value: `${item.node.id}\u0000${item.path}`,
                        label: `${item.node.title || item.node.id} · ${item.path} (${item.field.type})`,
                      })),
                      value,
                      `${binding.node} · ${binding.path} (missing)`,
                    )}
                    onChange={(next) => {
                      const found = upstream.find(
                        (item) => `${item.node.id}\u0000${item.path}` === next,
                      );
                      if (!found) return;
                      set((current) => ({
                        ...current,
                        bindings: (current.bindings ?? []).map((item, position) =>
                          position === index
                            ? {
                                name: found.field.name,
                                node: found.node.id,
                                path: found.path,
                                field: found.field,
                              }
                            : item,
                        ),
                      }));
                    }}
                  />
                </Labeled>
              </div>
              <div className="w-36">
                <Labeled id={`${id}-name`} label="Name">
                  <Input
                    id={`${id}-name`}
                    value={binding.name}
                    readOnly={readOnly}
                    onChange={(name) =>
                      set((current) => ({
                        ...current,
                        bindings: (current.bindings ?? []).map((item, position) =>
                          position === index
                            ? { ...item, name, field: { ...item.field, name } }
                            : item,
                        ),
                      }))
                    }
                  />
                </Labeled>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                tooltip="Remove input"
                ariaLabel={`Remove input ${binding.name}`}
                disabled={readOnly}
                onClick={() =>
                  set((current) => {
                    const bindings = (current.bindings ?? []).filter(
                      (_, position) => position !== index,
                    );
                    const { bindings: _previous, ...rest } = current;
                    return bindings.length === 0 ? rest : { ...rest, bindings };
                  })
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          );
        })}
        <Problems problems={problems} nodeId={node.id} control="bindings" />
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || upstream.length === 0}
            onClick={() => {
              const first = upstream[0];
              if (!first) return;
              set((current) => ({
                ...current,
                bindings: [
                  ...(current.bindings ?? []),
                  {
                    name: first.field.name,
                    node: first.node.id,
                    path: first.path,
                    field: first.field,
                  },
                ],
              }));
            }}
          >
            Add input
          </Button>
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-2 border-t border-border pt-4">
        <legend className="pb-1 text-xs font-medium text-muted-foreground">Report fields</legend>
        {node.report.fields.map((item, index) => {
          const id = controlId(node.id, `report.fields.${index}`);
          return (
            <div key={index} className="flex flex-col gap-2 rounded-lg border border-border p-2">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-32 flex-1">
                  <Labeled id={id} label={`Field ${index + 1} name`}>
                    <Input
                      id={id}
                      value={item.name}
                      readOnly={readOnly}
                      invalid={invalid(`report.fields.${index}`)}
                      onChange={(name) => field(index, { name })}
                    />
                  </Labeled>
                </div>
                <div className="w-32">
                  <Labeled id={`${id}-type`} label="Type">
                    <Select
                      id={`${id}-type`}
                      value={item.type}
                      disabled={readOnly}
                      options={[
                        { value: "boolean", label: "Yes/no" },
                        { value: "string", label: "Text" },
                        { value: "number", label: "Number" },
                        { value: "enum", label: "One of" },
                      ]}
                      onChange={(type) => field(index, { type: type as Field["type"] })}
                    />
                  </Labeled>
                </div>
                <div className="w-32">
                  <Labeled id={`${id}-required`} label="Presence">
                    <Select
                      id={`${id}-required`}
                      value={item.required ? "required" : "optional"}
                      disabled={readOnly}
                      options={[
                        { value: "required", label: "Required" },
                        { value: "optional", label: "Optional" },
                      ]}
                      onChange={(value) => field(index, { required: value === "required" })}
                    />
                  </Labeled>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  tooltip="Remove field"
                  ariaLabel={`Remove report field ${item.name}`}
                  disabled={readOnly}
                  onClick={() =>
                    set((current) => ({
                      ...current,
                      report: {
                        ...current.report,
                        fields: current.report.fields.filter((_, position) => position !== index),
                      },
                    }))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
              {item.type === "enum" ? (
                <Labeled id={`${id}-values`} label="Allowed values, one per line">
                  <Textarea
                    id={`${id}-values`}
                    rows={3}
                    value={(item.values ?? []).join("\n")}
                    readOnly={readOnly}
                    onChange={(text) =>
                      field(index, {
                        values: text
                          .split("\n")
                          .filter(
                            (value, position, all) => value !== "" || position === all.length - 1,
                          ),
                      })
                    }
                  />
                </Labeled>
              ) : null}
              <Problems problems={problems} nodeId={node.id} control={`report.fields.${index}`} />
            </div>
          );
        })}
        <Problems problems={problems} nodeId={node.id} control="report.fields" />
        <div className="flex flex-wrap items-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly}
            onClick={() =>
              set((current) => ({
                ...current,
                report: {
                  ...current.report,
                  fields: [
                    ...current.report.fields,
                    {
                      name: `field${current.report.fields.length + 1}`,
                      type: "boolean",
                      required: true,
                    },
                  ],
                },
              }))
            }
          >
            Add report field
          </Button>
          <div className="w-48">
            <Labeled id={controlId(node.id, "evidenceRequired")} label="Evidence">
              <Select
                id={controlId(node.id, "evidenceRequired")}
                value={node.report.evidenceRequired ? "required" : "optional"}
                disabled={readOnly}
                options={[
                  { value: "optional", label: "Optional" },
                  { value: "required", label: "Required" },
                ]}
                onChange={(value) =>
                  set((current) => {
                    const { evidenceRequired: _previous, ...report } = current.report;
                    return {
                      ...current,
                      report: value === "required" ? { ...report, evidenceRequired: true } : report,
                    };
                  })
                }
              />
            </Labeled>
          </div>
        </div>
      </fieldset>
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <RouteSelect
          props={props}
          definition={definition}
          node={node}
          control="next"
          label="Next step"
          route={node.next}
          optional={false}
          readOnly={readOnly}
          problems={problems}
          onRoute={(route) => route && set((current) => ({ ...current, next: route }))}
        />
        <RouteSelect
          props={props}
          definition={definition}
          node={node}
          control="onUnresolved"
          label="If unresolved"
          route={node.onUnresolved}
          optional
          readOnly={readOnly}
          problems={problems}
          onRoute={(route) =>
            set((current) => {
              const { onUnresolved: _previous, ...rest } = current;
              return route === undefined ? rest : { ...rest, onUnresolved: route };
            })
          }
        />
      </div>
      <Problems problems={problems} nodeId={node.id} control="" />
    </div>
  );
}
