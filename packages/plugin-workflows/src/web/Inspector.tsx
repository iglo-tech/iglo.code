import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderInstanceId, RuntimeMode } from "@t3tools/plugin-host-contract/schema";
import type { Agent, Field, Node, Skill } from "../contracts.ts";
import { Labeled, errorMessage } from "./common.tsx";
import {
  addBranch,
  isProtected,
  joinOf,
  kindLabels,
  moveBranch,
  removeBranch,
  updateNode,
  upstreamFields,
  type Branch,
} from "./editing.ts";
import { KindIcon } from "./kinds.tsx";
import {
  Problems,
  RouteEditor,
  controlId,
  matches,
  minutes,
  nodeOptions,
  withCurrent,
  type InspectorProps,
} from "./Routes.tsx";
import { CheckInspector, DecisionInspector, HumanInspector } from "./Steps.tsx";

export { controlId };

type AgentNode = Extract<Node, { kind: "agent" }>;
type ParallelNode = Extract<Node, { kind: "parallel" }>;
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
      ) : node.kind === "check" ? (
        <CheckInspector key={node.id} {...input} node={node} />
      ) : node.kind === "decision" ? (
        <DecisionInspector key={node.id} {...input} node={node} />
      ) : node.kind === "human" ? (
        <HumanInspector key={node.id} {...input} node={node} />
      ) : node.kind === "parallel" ? (
        <ParallelInspector key={node.id} {...input} node={node} />
      ) : (
        <DecisionInspector key={node.id} {...input} node={node} />
      )}
    </section>
  );
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

function AgentInspector(input: InspectorProps & { readonly node: AgentNode }) {
  const { props, definition, node, problems, readOnly, onChange } = input;
  const set = (update: (current: AgentNode) => AgentNode) =>
    onChange(updateNode(definition, node.id, (current) => update(current as AgentNode)));
  const invalid = (control: string) =>
    problems.some((problem) => matches(problem, node.id, control));
  return (
    <div className="flex flex-col gap-3">
      <Labeled id={controlId(node.id, "title")} label="Label">
        <props.Input
          id={controlId(node.id, "title")}
          value={node.title}
          readOnly={readOnly}
          invalid={invalid("title")}
          onChange={(title) => set((current) => ({ ...current, title }))}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="title" />
      <AgentFields
        {...input}
        nodeId={node.id}
        prefix=""
        agent={node}
        reviewer={false}
        set={(update) => set((current) => update(current) as AgentNode)}
      />
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <RouteEditor
          props={props}
          definition={definition}
          node={node}
          control="next"
          label="Next"
          route={node.next}
          optional={false}
          readOnly={readOnly}
          problems={problems}
          onRoute={(route) => route && set((current) => ({ ...current, next: route }))}
        />
        <RouteEditor
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

function AgentFields({
  props,
  definition,
  capabilities,
  capabilitiesError,
  onRetryCapabilities,
  problems,
  readOnly,
  nodeId,
  prefix,
  agent,
  reviewer,
  set,
}: InspectorProps & {
  readonly nodeId: string;
  /** Control prefix of this agent inside its node (`branches.0.` for a reviewer). */
  readonly prefix: string;
  readonly agent: Agent;
  /** Reviewers keep the canonical review permission policy. */
  readonly reviewer: boolean;
  /** Updates keep every property of the owning node or branch they do not change. */
  readonly set: (update: (current: Agent) => Agent) => void;
}) {
  const { Input, Select, Textarea, Button, client, projectId, connection } = props;
  const cid = (control: string) => controlId(nodeId, `${prefix}${control}`);
  const invalid = (control: string) =>
    problems.some((problem) => matches(problem, nodeId, `${prefix}${control}`));
  const providers = capabilities?.providers ?? [];
  const provider = providers.find((item) => item.instanceId === agent.modelSelection.instanceId);
  const model = provider?.models.find((item) => item.slug === agent.modelSelection.model);
  const [skills, setSkills] = useState<ReadonlyArray<Skill> | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsAttempt, setSkillsAttempt] = useState(0);
  const instanceId = agent.modelSelection.instanceId;
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
  const upstream = upstreamFields(definition, nodeId);
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
    agent.modelSelection.options?.find((option) => option.id === id)?.value;
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
        id={cid("modelSelection")}
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
          id={cid("modelSelection")}
          value={agent.modelSelection.instanceId}
          disabled={readOnly}
          invalid={invalid("modelSelection")}
          options={withCurrent(
            providers.map((item) => ({
              value: item.instanceId,
              label: `${item.displayName ?? item.instanceId}${
                item.reporting ? (item.available ? "" : " — not ready") : " — cannot report"
              }`,
            })),
            agent.modelSelection.instanceId,
            `${agent.modelSelection.instanceId} (not in this environment)`,
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
      <Problems problems={problems} nodeId={nodeId} control={`${prefix}modelSelection`} />
      <Labeled id={cid("model")} label="Model">
        <Select
          id={cid("model")}
          value={agent.modelSelection.model}
          disabled={readOnly}
          options={withCurrent(
            (provider?.models ?? []).map((item) => ({
              value: item.slug,
              label: `${item.name}${item.isCustom ? " (custom)" : ""}`,
            })),
            agent.modelSelection.model,
            `${agent.modelSelection.model} (not listed)`,
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
        const id = cid(`option-${descriptor.id}`);
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
      {reviewer &&
      (agent.interactionMode !== "plan" || agent.runtimeMode !== "approval-required") ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>Not the review permission policy</span>
          <Button
            size="xs"
            variant="outline"
            disabled={readOnly}
            onClick={() =>
              set((current) => ({
                ...current,
                interactionMode: "plan",
                runtimeMode: "approval-required",
              }))
            }
          >
            Use the review permission policy
          </Button>
        </div>
      ) : null}
      <Labeled
        id={cid("runtimeMode")}
        label="Runtime mode"
        hint={reviewer ? "Review policy · plan mode, ask before external actions" : null}
      >
        <Select
          id={cid("runtimeMode")}
          value={agent.runtimeMode}
          disabled={readOnly || reviewer}
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
      <Problems problems={problems} nodeId={nodeId} control={`${prefix}runtimeMode`} />
      <Labeled id={cid("interactionMode")} label="Interaction mode">
        <Select
          id={cid("interactionMode")}
          value={agent.interactionMode ?? "default"}
          disabled={readOnly || reviewer}
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
        id={cid("skill")}
        label="Installed skill"
        hint={
          skillsError !== null
            ? null
            : agent.skill !== undefined &&
                skills !== null &&
                !skills.some((skill) => skill.name === agent.skill && skill.enabled)
              ? `${agent.skill} is not installed for this provider. Choose an installed skill.`
              : skills === null && connection === "connected"
                ? "Loading skills…"
                : null
        }
      >
        <Select
          id={cid("skill")}
          value={agent.skill ?? ""}
          disabled={readOnly}
          invalid={invalid("skill")}
          options={withCurrent(
            skillOptions,
            agent.skill ?? "",
            `${agent.skill ?? ""} (not installed)`,
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
      <Problems problems={problems} nodeId={nodeId} control={`${prefix}skill`} />
      <Labeled id={cid("instruction")} label="Instructions" hint={protectedNote(agent.instruction)}>
        <Textarea
          id={cid("instruction")}
          rows={6}
          value={agent.instruction}
          readOnly={readOnly}
          invalid={invalid("instruction")}
          onChange={(instruction) => set((current) => ({ ...current, instruction }))}
        />
      </Labeled>
      <Problems problems={problems} nodeId={nodeId} control={`${prefix}instruction`} />
      <div className="grid grid-cols-2 gap-3">
        <Labeled
          id={cid("timeoutMs")}
          label={reviewer ? "Review deadline (min)" : "Deadline (min)"}
        >
          <Input
            id={cid("timeoutMs")}
            type="number"
            placeholder="120"
            value={minutes(agent.timeoutMs)}
            readOnly={readOnly}
            invalid={invalid("timeoutMs")}
            onChange={(value) => timeout("timeoutMs", value)}
          />
        </Labeled>
        <Labeled id={cid("humanTimeoutMs")} label="Input deadline (min)">
          <Input
            id={cid("humanTimeoutMs")}
            type="number"
            value={minutes(agent.humanTimeoutMs)}
            readOnly={readOnly}
            onChange={(value) => timeout("humanTimeoutMs", value)}
          />
        </Labeled>
      </div>
      <fieldset className="flex flex-col gap-2 border-t border-border pt-4">
        <legend className="pb-1 text-xs font-medium text-muted-foreground">Inputs</legend>
        {(agent.bindings ?? []).map((binding, index) => {
          const id = cid(`bindings.${index}`);
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
        <Problems problems={problems} nodeId={nodeId} control={`${prefix}bindings`} />
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
        {agent.report.fields.map((item, index) => {
          const id = cid(`report.fields.${index}`);
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
              <Problems
                problems={problems}
                nodeId={nodeId}
                control={`${prefix}report.fields.${index}`}
              />
            </div>
          );
        })}
        <Problems problems={problems} nodeId={nodeId} control={`${prefix}report.fields`} />
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
            <Labeled id={cid("evidenceRequired")} label="Evidence">
              <Select
                id={cid("evidenceRequired")}
                value={agent.report.evidenceRequired ? "required" : "optional"}
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
    </div>
  );
}

/**
 * Reviewers of one frozen pull request head, each a distinct branch with a stable identity.
 * Labels and order are presentation; join rules and inputs refer to the identity.
 */
function ParallelInspector(input: InspectorProps & { readonly node: ParallelNode }) {
  const { props, definition, node, problems, readOnly, onChange, capabilities } = input;
  const { Input, Button, Badge } = props;
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, node.branches.length - 1);
  const branch = node.branches[index]!;
  const set = (update: (current: ParallelNode) => ParallelNode) =>
    onChange(updateNode(definition, node.id, (current) => update(current as ParallelNode)));
  const setBranch = (update: (current: Agent) => Agent) =>
    set((current) => ({
      ...current,
      branches: current.branches.map((item, position) =>
        position === index ? (update(item) as Branch) : item,
      ),
    }));
  const invalid = (control: string) =>
    problems.some((problem) => matches(problem, node.id, control));
  const join = joinOf(definition, node.id);
  const pullRequest = (update: Partial<ParallelNode["pullRequest"]>) =>
    set((current) => ({ ...current, pullRequest: { ...current.pullRequest, ...update } }));
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
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Join</span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <span className="truncate">{join ? join.title || join.id : "Missing join"}</span>
          <Badge variant={join ? "outline" : "warning"}>
            Wait for all · {node.branches.length}{" "}
            {node.branches.length === 1 ? "reviewer" : "reviewers"}
          </Badge>
        </span>
      </div>
      <fieldset className="flex flex-col gap-2 border-t border-border pt-4">
        <legend className="pb-1 text-xs font-medium text-muted-foreground">Pull request</legend>
        <Labeled id={controlId(node.id, "pullRequest.repository")} label="Repository">
          <Input
            id={controlId(node.id, "pullRequest.repository")}
            value={node.pullRequest.repository}
            placeholder="owner/name"
            readOnly={readOnly}
            invalid={invalid("pullRequest.repository")}
            onChange={(repository) => pullRequest({ repository })}
          />
        </Labeled>
        <Problems problems={problems} nodeId={node.id} control="pullRequest.repository" />
        <div className="grid grid-cols-2 gap-3">
          <Labeled id={controlId(node.id, "pullRequest.number")} label="Number">
            <Input
              id={controlId(node.id, "pullRequest.number")}
              type="number"
              value={String(node.pullRequest.number)}
              readOnly={readOnly}
              invalid={invalid("pullRequest.number")}
              onChange={(value) => {
                const number = Number.parseInt(value, 10);
                if (Number.isInteger(number) && number > 0) pullRequest({ number });
              }}
            />
          </Labeled>
          <Labeled id={controlId(node.id, "pullRequest.host")} label="Forge host">
            <Input
              id={controlId(node.id, "pullRequest.host")}
              value={node.pullRequest.host ?? ""}
              placeholder="Project default"
              readOnly={readOnly}
              onChange={(host) =>
                set((current) => {
                  const { host: _previous, ...rest } = current.pullRequest;
                  return {
                    ...current,
                    pullRequest: host.trim() === "" ? rest : { ...rest, host },
                  };
                })
              }
            />
          </Labeled>
        </div>
      </fieldset>
      <section
        aria-labelledby={`${controlId(node.id, "branches")}-title`}
        className="flex flex-col gap-2 border-t border-border pt-4"
      >
        <div className="flex items-center gap-2">
          <h3
            id={`${controlId(node.id, "branches")}-title`}
            className="text-xs font-medium text-muted-foreground"
          >
            Reviewers
          </h3>
          <Button
            size="xs"
            variant="ghost"
            ariaLabel="Add reviewer"
            disabled={readOnly || node.branches.length >= 32}
            onClick={() => {
              onChange(addBranch(definition, node.id, capabilities));
              setSelected(node.branches.length);
            }}
          >
            <PlusIcon />
            Reviewer
          </Button>
        </div>
        <ol aria-label="Reviewers" className="flex flex-col gap-px">
          {node.branches.map((item, position) => {
            const name = item.title || item.id;
            const issues = problems.filter(
              (problem) =>
                problem.nodeId === node.id &&
                (problem.control === `branches.${position}` ||
                  problem.control?.startsWith(`branches.${position}.`) === true),
            ).length;
            return (
              <li key={item.id} className="flex min-w-0 items-center gap-0.5">
                <Button
                  size="row"
                  variant={position === index ? "outline" : "ghost"}
                  ariaPressed={position === index}
                  ariaLabel={`Edit reviewer ${name} (${item.id})${issues ? `, ${issues} to fix` : ""}`}
                  onClick={() => setSelected(position)}
                >
                  <KindIcon kind="branch" className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{name}</span>
                  <span className="truncate text-muted-foreground">
                    {item.skill ? item.skill : item.id}
                  </span>
                  {issues ? (
                    <span className="ml-auto flex shrink-0">
                      <Badge variant="error">{issues} to fix</Badge>
                    </span>
                  ) : null}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel={`Move reviewer ${name} up`}
                  tooltip="Move up"
                  disabled={readOnly || position === 0}
                  onClick={() => {
                    onChange(moveBranch(definition, node.id, position, -1));
                    if (position === index) setSelected(position - 1);
                  }}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel={`Move reviewer ${name} down`}
                  tooltip="Move down"
                  disabled={readOnly || position === node.branches.length - 1}
                  onClick={() => {
                    onChange(moveBranch(definition, node.id, position, 1));
                    if (position === index) setSelected(position + 1);
                  }}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  ariaLabel={`Remove reviewer ${name}`}
                  tooltip="Remove reviewer"
                  disabled={readOnly || node.branches.length === 1}
                  onClick={() => {
                    onChange(removeBranch(definition, node.id, position));
                    setSelected(Math.max(0, Math.min(index, node.branches.length - 2)));
                  }}
                >
                  <Trash2Icon />
                </Button>
              </li>
            );
          })}
        </ol>
        <Problems problems={problems} nodeId={node.id} control="branches" exact />
      </section>
      <fieldset
        key={branch.id}
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-2.5"
      >
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          {branch.title || branch.id}
        </legend>
        <Labeled
          id={controlId(node.id, `branches.${index}.title`)}
          label="Label"
          hint={`ID ${branch.id}`}
        >
          <Input
            id={controlId(node.id, `branches.${index}.title`)}
            value={branch.title}
            readOnly={readOnly}
            invalid={invalid(`branches.${index}.title`)}
            onChange={(title) =>
              set((current) => ({
                ...current,
                branches: current.branches.map((item, position) =>
                  position === index ? { ...item, title } : item,
                ),
              }))
            }
          />
        </Labeled>
        <Problems problems={problems} nodeId={node.id} control={`branches.${index}`} exact />
        <AgentFields
          {...input}
          nodeId={node.id}
          prefix={`branches.${index}.`}
          agent={branch}
          reviewer
          set={setBranch}
        />
      </fieldset>
      <Problems problems={problems} nodeId={node.id} control="next" />
      <Problems problems={problems} nodeId={node.id} control="" />
    </div>
  );
}
