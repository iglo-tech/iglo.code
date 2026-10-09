import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Field, Node, Predicate, Route, Value } from "../contracts.ts";
import { sourceFields, upstreamOf } from "../definition.ts";
import { Labeled } from "./common.tsx";
import {
  addTerm,
  countTerms,
  depthLimit,
  firstLeaf,
  inValueLimit,
  isGroup,
  leafFor,
  operatorLabels,
  operatorsFor,
  readsAs,
  removeTerm,
  termControl,
  termLimit,
  updateTerm,
  withOperator,
  type TermPath,
} from "./decisions.ts";
import { isProtected, updateNode } from "./editing.ts";
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

type CheckNode = Extract<Node, { kind: "check" }>;
type DecisionNode = Extract<Node, { kind: "decision" }>;
type HumanNode = Extract<Node, { kind: "human" }>;
const fieldTypes: Record<Field["type"], string> = {
  boolean: "bool",
  string: "text",
  number: "number",
  enum: "enum",
};
const typeLabels: Record<Field["type"], string> = {
  boolean: "yes/no",
  string: "text",
  number: "number",
  enum: "one of",
};

function stepEditing<N extends Node>({ definition, node, problems, onChange }: StepProps<N>) {
  return {
    set: (update: (current: N) => N) =>
      onChange(updateNode(definition, node.id, (current) => update(current as N))),
    invalid: (control: string) =>
      problems.some((problem) => matches(problem, node.id, control, true)),
  };
}
type StepProps<N extends Node> = InspectorProps & { readonly node: N };

function TitleField<N extends Node>(input: StepProps<N>) {
  const { set, invalid } = stepEditing(input);
  const { props, node, readOnly, problems } = input;
  return (
    <>
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
    </>
  );
}

/** A titled block of the inspector, separated like the agent inspector's sections. */
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A deterministic command in the run's workspace; the backend owns where and how it runs. */
export function CheckInspector(input: StepProps<CheckNode>) {
  const { props, definition, node, problems, readOnly } = input;
  const { set, invalid } = stepEditing(input);
  const { Input, Select, Textarea, Badge, Tooltip } = props;
  const route = (key: "next" | "onUnresolved", value: Route | undefined) =>
    set((current) => {
      const { onUnresolved: _previous, ...rest } = current;
      return key === "next"
        ? { ...current, next: value ?? current.next }
        : value === undefined
          ? rest
          : { ...rest, onUnresolved: value };
    });
  const published = [...sourceFields(node, definition)];
  return (
    <div className="flex flex-col gap-3">
      <TitleField {...input} />
      <Labeled
        id={controlId(node.id, "command")}
        label="Command"
        hint={isProtected(node.command) ? "Protected value · kept on save unless replaced" : null}
      >
        <Input
          id={controlId(node.id, "command")}
          value={node.command}
          placeholder="npm"
          readOnly={readOnly}
          invalid={invalid("command")}
          onChange={(command) => set((current) => ({ ...current, command }))}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="command" />
      <Labeled id={controlId(node.id, "args")} label="Arguments · one per line">
        <Textarea
          id={controlId(node.id, "args")}
          rows={2}
          value={node.args.join("\n")}
          readOnly={readOnly}
          invalid={invalid("args")}
          onChange={(text) =>
            set((current) => ({
              ...current,
              args: text
                .split("\n")
                .filter((arg, index, all) => arg !== "" || index === all.length - 1),
            }))
          }
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="args" />
      <div className="grid grid-cols-2 gap-2">
        <Labeled id={controlId(node.id, "timeoutMs")} label="Timeout (min)">
          <Input
            id={controlId(node.id, "timeoutMs")}
            type="number"
            placeholder="120"
            value={minutes(node.timeoutMs)}
            readOnly={readOnly}
            invalid={invalid("timeoutMs")}
            onChange={(value) =>
              set((current) => {
                const { timeoutMs: _previous, ...rest } = current;
                const parsed = Number.parseFloat(value);
                return Number.isFinite(parsed)
                  ? { ...rest, timeoutMs: Math.round(parsed * 60_000) }
                  : rest;
              })
            }
          />
        </Labeled>
        {/* Workspace and retry policy are fixed by the backend; other choices show as unavailable. */}
        <Labeled id={controlId(node.id, "retry")} label="Retry">
          <Select
            id={controlId(node.id, "retry")}
            value="manual"
            disabled
            options={[
              { value: "manual", label: "Manual" },
              { value: "automatic", label: "Retry automatically (not available)", disabled: true },
            ]}
            onChange={() => {}}
          />
        </Labeled>
      </div>
      <Problems problems={problems} nodeId={node.id} control="timeoutMs" />
      <Labeled id={controlId(node.id, "workspace")} label="Runs in">
        <Select
          id={controlId(node.id, "workspace")}
          value="run"
          disabled
          options={[
            { value: "run", label: "The run's workspace" },
            { value: "other", label: "A separate workspace (not available)", disabled: true },
          ]}
          onChange={() => {}}
        />
      </Labeled>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Result fields</span>
        <ul aria-label="Result fields" className="flex flex-wrap gap-1">
          {published.map(([path, field]) => (
            <li key={path} className="flex min-w-0">
              <Tooltip
                content={`${typeLabels[field.type]}${field.values ? `: ${field.values.join(", ")}` : ""}${field.required ? "" : " · absent without an exit code"}`}
              >
                <Badge variant="outline">
                  {path}
                  {field.required ? "" : "?"}
                </Badge>
              </Tooltip>
            </li>
          ))}
        </ul>
      </div>
      <Section title="Routes">
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
          onRoute={(value) => route("next", value)}
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
          onRoute={(value) => route("onUnresolved", value)}
        />
      </Section>
      <Problems problems={problems} nodeId={node.id} control="" />
    </div>
  );
}

/** Approve and Request changes destinations; the run waits here for a person's decision. */
export function HumanInspector(input: StepProps<HumanNode>) {
  const { props, definition, node, problems, readOnly } = input;
  const { set } = stepEditing(input);
  return (
    <div className="flex flex-col gap-3">
      <TitleField {...input} />
      <Section title="Routes">
        {(["approve", "changes"] as const).map((key) => (
          <RouteEditor
            key={key}
            props={props}
            definition={definition}
            node={node}
            control={key}
            label={key === "approve" ? "Approve" : "Request changes"}
            route={node[key]}
            optional={false}
            readOnly={readOnly}
            problems={problems}
            onRoute={(value) => value && set((current) => ({ ...current, [key]: value }))}
          />
        ))}
      </Section>
      <Problems problems={problems} nodeId={node.id} control="" />
    </div>
  );
}

/**
 * Ordered rules over a source's declared fields. The server evaluates them in order and the
 * first match decides; Otherwise is required and used when none match.
 */
export function DecisionInspector(input: StepProps<DecisionNode>) {
  const { props, definition, node, problems, readOnly } = input;
  const { set, invalid } = stepEditing(input);
  const { Button, Select, SegmentedControl, Tooltip } = props;
  const fields = sourceFields(
    definition.nodes.find((item) => item.id === node.source),
    definition,
  );
  // Only steps that run before this decision have a result for it to read.
  const before = upstreamOf(definition, node.id);
  const sources = nodeOptions(
    definition,
    (item) => before.has(item.id) && sourceFields(item, definition).size > 0,
  );
  const terms = node.rules.reduce((total, rule) => total + countTerms(rule.when), 0);
  const full = terms >= termLimit;
  const rules = (update: (rules: DecisionNode["rules"]) => DecisionNode["rules"]) =>
    set((current) => ({ ...current, rules: update(current.rules) }));
  const rule = (
    index: number,
    update: (rule: DecisionNode["rules"][number]) => DecisionNode["rules"][number],
  ) =>
    rules((current) => current.map((item, position) => (position === index ? update(item) : item)));
  const move = (index: number, offset: -1 | 1) =>
    rules((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(index + offset, 0, item!);
      return next;
    });
  return (
    <div className="flex flex-col gap-3">
      <TitleField {...input} />
      <Labeled id={controlId(node.id, "source")} label="Decide on">
        <Select
          id={controlId(node.id, "source")}
          value={node.source}
          disabled={readOnly}
          invalid={invalid("source")}
          options={withCurrent(
            [...(node.source === "" ? [{ value: "", label: "Choose a step" }] : []), ...sources],
            node.source,
            `${node.source} (missing, no fields, or runs later)`,
          )}
          onChange={(source) => set((current) => ({ ...current, source }))}
        />
      </Labeled>
      <Problems problems={problems} nodeId={node.id} control="source" />
      <section
        aria-labelledby={`${controlId(node.id, "rules")}-title`}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center gap-2 border-t border-border pt-4">
          <h3
            id={`${controlId(node.id, "rules")}-title`}
            className="text-xs font-medium text-muted-foreground"
          >
            Rules · first match wins
          </h3>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            <Tooltip content="Conditions used across all rules">
              {terms}/{termLimit}
            </Tooltip>
          </span>
          <Button
            size="xs"
            variant="ghost"
            ariaLabel="Add rule"
            {...(fields.size === 0 ? { tooltip: "Choose a step with result fields first" } : {})}
            disabled={readOnly || fields.size === 0 || full}
            onClick={() =>
              rules((current) => [
                ...current,
                {
                  when: { op: "all", terms: [firstLeaf(fields)] },
                  route: { to: node.otherwise.to },
                },
              ])
            }
          >
            <PlusIcon />
            Rule
          </Button>
        </div>
        <ol aria-label="Rules in first-match order" className="flex flex-col gap-2">
          {node.rules.map((item, index) => {
            const reads = `If ${readsAs(item.when, fields)}`;
            return (
              <li
                key={index}
                className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-2.5"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="text-xs font-semibold tabular-nums">Rule {index + 1}</span>
                  {isGroup(item.when) ? (
                    <SegmentedControl
                      ariaLabel={`Rule ${index + 1} matches`}
                      value={item.when.op}
                      disabled={readOnly}
                      options={[
                        { value: "all", label: "All" },
                        { value: "any", label: "Any" },
                      ]}
                      onChange={(op) =>
                        rule(index, (current) => ({
                          ...current,
                          when: { ...current.when, op: op as "all" | "any" },
                        }))
                      }
                    />
                  ) : null}
                  <span className="ml-auto flex shrink-0">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      ariaLabel={`Move rule ${index + 1} up`}
                      tooltip="Move up"
                      disabled={readOnly || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      ariaLabel={`Move rule ${index + 1} down`}
                      tooltip="Move down"
                      disabled={readOnly || index === node.rules.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      ariaLabel={`Remove rule ${index + 1}`}
                      tooltip="Remove rule"
                      disabled={readOnly}
                      onClick={() =>
                        rules((current) => current.filter((_, position) => position !== index))
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </span>
                </div>
                <Term
                  {...input}
                  fields={fields}
                  rule={index}
                  predicate={item.when}
                  path={[]}
                  depth={1}
                  full={full}
                  onPredicate={(when) => rule(index, (current) => ({ ...current, when }))}
                />
                <p
                  className="flex min-w-0 text-xs text-muted-foreground"
                  id={`${controlId(node.id, `rules.${index}`)}-reads`}
                >
                  <Tooltip content={reads}>Reads as: {reads}</Tooltip>
                </p>
                <RouteEditor
                  props={props}
                  definition={definition}
                  node={node}
                  control={`rules.${index}`}
                  label="Then"
                  name={`Rule ${index + 1}`}
                  route={item.route}
                  optional={false}
                  readOnly={readOnly}
                  problems={problems}
                  onRoute={(route) => route && rule(index, (current) => ({ ...current, route }))}
                />
              </li>
            );
          })}
        </ol>
        <Problems problems={problems} nodeId={node.id} control="rules" exact />
        <div className="rounded-lg border border-border bg-card p-2.5">
          <RouteEditor
            props={props}
            definition={definition}
            node={node}
            control="otherwise"
            label="Otherwise"
            route={node.otherwise}
            optional={false}
            readOnly={readOnly}
            problems={problems}
            onRoute={(route) => route && set((current) => ({ ...current, otherwise: route }))}
          />
        </div>
      </section>
      <Problems problems={problems} nodeId={node.id} control="" />
    </div>
  );
}

/** One condition or Match all/Match any group, located by its index path in the rule. */
function Term(
  input: StepProps<DecisionNode> & {
    readonly fields: ReadonlyMap<string, Field>;
    readonly rule: number;
    readonly predicate: Predicate;
    readonly path: TermPath;
    readonly depth: number;
    readonly full: boolean;
    readonly onPredicate: (predicate: Predicate) => void;
    /** Removes this term from its group; absent for a rule's root. */
    readonly remove?: {
      readonly label: string;
      readonly disabled: boolean;
      readonly run: () => void;
    };
  },
) {
  const { props, node, problems, readOnly, fields, rule, predicate, path, depth, full, remove } =
    input;
  const { Button, Select, Input, Textarea, SegmentedControl } = props;
  const control = termControl(rule, path);
  const id = controlId(node.id, control);
  const invalid = problems.some((problem) => matches(problem, node.id, control, true));
  const change = (at: TermPath, update: (term: Predicate) => Predicate) =>
    input.onPredicate(updateTerm(predicate, at, update));
  // Each level edits its own term; `path` only names controls and nested problems.
  const root = path.length === 0;
  const owner = root ? `rule ${rule + 1}` : "this group";
  const add = (term: Predicate) => input.onPredicate(addTerm(predicate, [], term));
  // A condition added here sits one level deeper; a group needs room for its own condition.
  const canAddCondition = !readOnly && !full && fields.size > 0 && depth + 1 <= depthLimit;
  const canAddGroup = !readOnly && !full && fields.size > 0 && depth + 2 <= depthLimit;
  const removeButton =
    remove === undefined ? null : (
      <Button
        size="icon-xs"
        variant="ghost"
        ariaLabel={remove.label}
        tooltip="Remove"
        disabled={readOnly || remove.disabled}
        onClick={remove.run}
      >
        <XIcon />
      </Button>
    );
  const adders = (
    <span className="flex flex-wrap gap-1">
      <Button
        size="xs"
        variant="ghost"
        ariaLabel={`Add condition to ${owner}`}
        disabled={!canAddCondition}
        onClick={() => add(firstLeaf(fields))}
      >
        <PlusIcon />
        Condition
      </Button>
      <Button
        size="xs"
        variant="ghost"
        ariaLabel={`Add group to ${owner}`}
        disabled={!canAddGroup}
        onClick={() => add({ op: "any", terms: [firstLeaf(fields)] })}
      >
        <PlusIcon />
        Group
      </Button>
    </span>
  );
  if (isGroup(predicate)) {
    const terms = predicate.terms ?? [];
    const list = (
      <ul className="flex flex-col gap-2">
        {terms.map((term, index) => (
          <li key={index}>
            <Term
              {...input}
              predicate={term}
              path={[...path, index]}
              depth={depth + 1}
              onPredicate={(next) => change([index], () => next)}
              remove={{
                label: `Remove ${isGroup(term) ? "group" : "condition"} ${index + 1} of ${owner}`,
                disabled: terms.length === 1,
                run: () => input.onPredicate(removeTerm(predicate, [index])),
              }}
            />
          </li>
        ))}
      </ul>
    );
    // A rule's own Match all/any sits in its card header.
    if (root)
      return (
        <div className="flex flex-col gap-2">
          <Problems problems={problems} nodeId={node.id} control={control} exact />
          {list}
          {adders}
        </div>
      );
    return (
      <div
        role="group"
        aria-label={`Group ${(path.at(-1) ?? 0) + 1}`}
        className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Group</span>
          <SegmentedControl
            ariaLabel={`Group ${(path.at(-1) ?? 0) + 1} matches`}
            value={predicate.op}
            disabled={readOnly}
            options={[
              { value: "all", label: "All" },
              { value: "any", label: "Any" },
            ]}
            onChange={(op) => change([], (group) => ({ ...group, op: op as "all" | "any" }))}
          />
          <span className="ml-auto">{removeButton}</span>
        </div>
        <Problems problems={problems} nodeId={node.id} control={control} exact />
        {list}
        {adders}
      </div>
    );
  }
  const fieldPath = predicate.path ?? "";
  const field = fields.get(fieldPath);
  const set = (next: Predicate) => change([], () => next);
  const value = predicate.value;
  const operand = (next: Value) => set({ ...predicate, value: next });
  let valueControl = null;
  let listControl = null;
  if (predicate.op === "in") {
    const values = predicate.values ?? [];
    listControl =
      field?.type === "enum" ? (
        <div role="group" aria-label="Values" className="flex flex-wrap gap-1">
          {(field.values ?? []).map((option) => (
            <Button
              key={option}
              size="xs"
              variant={values.includes(option) ? "default" : "outline"}
              ariaPressed={values.includes(option)}
              disabled={readOnly}
              onClick={() =>
                set({
                  ...predicate,
                  values: values.includes(option)
                    ? values.filter((item) => item !== option)
                    : [...values, option],
                })
              }
            >
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <Textarea
          id={`${id}-value`}
          ariaLabel={`Values, one per line (up to ${inValueLimit})`}
          rows={2}
          placeholder="One value per line"
          value={values.map(String).join("\n")}
          readOnly={readOnly}
          invalid={invalid}
          onChange={(text) =>
            set({
              ...predicate,
              values: text
                .split("\n")
                .filter((item, index, all) => item !== "" || index === all.length - 1),
            })
          }
        />
      );
  } else if (predicate.op !== "present" && predicate.op !== "absent") {
    valueControl =
      field?.type === "boolean" || (field === undefined && typeof value === "boolean") ? (
        <Select
          id={`${id}-value`}
          ariaLabel="Value"
          size="sm"
          value={String(value)}
          disabled={readOnly}
          invalid={invalid}
          options={[
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
          onChange={(next) => operand(next === "true")}
        />
      ) : field?.type === "enum" ? (
        <Select
          id={`${id}-value`}
          ariaLabel="Value"
          size="sm"
          value={String(value ?? "")}
          disabled={readOnly}
          invalid={invalid}
          options={withCurrent(
            (field.values ?? []).map((option) => ({ value: option, label: option })),
            String(value ?? ""),
            `${String(value ?? "")} (not allowed)`,
          )}
          onChange={operand}
        />
      ) : field?.type === "number" || (field === undefined && typeof value === "number") ? (
        <Input
          id={`${id}-value`}
          ariaLabel="Value"
          size="sm"
          type="number"
          value={String(value ?? "")}
          readOnly={readOnly}
          invalid={invalid}
          onChange={(text) => {
            const parsed = Number(text);
            if (text.trim() !== "" && Number.isFinite(parsed)) operand(parsed);
          }}
        />
      ) : (
        <Input
          id={`${id}-value`}
          ariaLabel="Value"
          size="sm"
          value={String(value ?? "")}
          readOnly={readOnly}
          invalid={invalid}
          onChange={operand}
        />
      );
  }
  const operators = operatorsFor(field);
  return (
    <div role="group" aria-label="Condition" className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <Select
            id={id}
            ariaLabel="Field"
            size="sm"
            value={fieldPath}
            disabled={readOnly}
            invalid={invalid}
            options={withCurrent(
              [...fields].map(([path, item]) => ({
                value: path,
                // Report fields read as their declared name; the type is a muted hint.
                label: `${path.split(".").at(-1) ?? path}${item.required ? "" : "?"}`,
                detail: fieldTypes[item.type],
              })),
              fieldPath,
              `${fieldPath} (missing field)`,
            )}
            onChange={(path) => set(leafFor(path, fields.get(path), predicate))}
          />
        </div>
        {removeButton}
      </div>
      <div className={valueControl === null ? "flex min-w-0" : "grid grid-cols-2 gap-1"}>
        <div className="min-w-0 flex-1">
          <Select
            id={`${id}-op`}
            ariaLabel="Operator"
            size="sm"
            value={predicate.op}
            disabled={readOnly}
            invalid={invalid}
            options={withCurrent(
              operators.map((op) => ({ value: op, label: operatorLabels[op] })),
              predicate.op,
              `${operatorLabels[predicate.op as keyof typeof operatorLabels]} (not valid here)`,
            )}
            onChange={(op) => set(withOperator(predicate, op as Predicate["op"], field))}
          />
        </div>
        {valueControl === null ? null : <div className="min-w-0">{valueControl}</div>}
      </div>
      {listControl}
      <Problems problems={problems} nodeId={node.id} control={control} exact />
      {root ? adders : null}
    </div>
  );
}
