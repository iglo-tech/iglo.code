import {
  limits,
  type Capabilities,
  type Definition,
  type Node,
  type Problem,
  type Route,
} from "../contracts.ts";
import { Labeled, type PageProps } from "./common.tsx";
import { kindLabels } from "./editing.ts";

export const minutes = (value: number | undefined) =>
  value === undefined ? "" : String(Math.round(value / 60_000));

export interface InspectorProps {
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

export const controlId = (nodeId: string | null, control: string) =>
  `wf-${nodeId ?? "workflow"}-${control.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
/**
 * Whether a located problem belongs to a control. An empty control matches the node's own
 * problems that name no control; `exact` excludes problems of nested controls.
 */
export const matches = (problem: Problem, nodeId: string | null, control: string, exact = false) =>
  (problem.nodeId ?? null) === nodeId &&
  (control === ""
    ? problem.control === undefined
    : problem.control !== undefined &&
      (problem.control === control || (!exact && problem.control.startsWith(`${control}.`))));

export function Problems({
  problems,
  nodeId,
  control,
  exact = false,
}: {
  readonly problems: ReadonlyArray<Problem>;
  readonly nodeId: string | null;
  readonly control: string;
  readonly exact?: boolean;
}) {
  const found = problems.filter((problem) => matches(problem, nodeId, control, exact));
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

export function nodeOptions(definition: Definition, filter: (node: Node) => boolean = () => true) {
  return definition.nodes.filter(filter).map((node) => ({
    value: node.id,
    label: `${node.title || node.id} (${kindLabels[node.kind]})`,
  }));
}
export function withCurrent(
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>,
  current: string,
  label: string,
) {
  return current === "" || options.some((option) => option.value === current)
    ? options
    : [{ value: current, label }, ...options];
}
const terminal = (node: Node) => node.kind === "end" || node.kind === "human";
/** Steps a repeat may return to: anything that does work or waits, never an end or a join. */
const returnable = (node: Node) => node.kind !== "end" && node.kind !== "join";
const repeatCounts = Array.from({ length: limits.repeats }, (_, index) => index + 1);

/**
 * One outgoing route: go to a step, or repeat a previous step with Return to, Maximum
 * repeats and At limit. The route keeps its canonical control so server problems land here.
 */
export function RouteEditor({
  props,
  definition,
  node,
  control,
  label,
  name = label,
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
  /** Names the route's controls for assistive technology when `label` alone is ambiguous. */
  readonly name?: string;
  readonly route: Route | undefined;
  readonly optional: boolean;
  readonly readOnly: boolean;
  readonly problems: ReadonlyArray<Problem>;
  readonly onRoute: (route: Route | undefined) => void;
}) {
  const { Select, SegmentedControl } = props;
  const id = controlId(node.id, control);
  const limitControl = `${control}.repeat`;
  const invalid = (name: string) =>
    problems.some((problem) => matches(problem, node.id, name, true));
  const repeat = route?.repeat;
  const toRepeat = (): Route => {
    // Default to the nearest earlier agent step in reading order, the usual rework target.
    const earlier = definition.nodes
      .slice(0, Math.max(0, definition.nodes.indexOf(node)))
      .toReversed();
    const to =
      earlier.find((item) => item.kind === "agent")?.id ?? earlier.find(returnable)?.id ?? node.id;
    const atLimit = definition.nodes.some(
      (item) => item.id === definition.atLimit && terminal(item),
    )
      ? definition.atLimit
      : (definition.nodes.find(terminal)?.id ?? definition.atLimit);
    return { to, repeat: { max: 1, atLimit } };
  };
  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span id={`${id}-label`} className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <SegmentedControl
          ariaLabel={`${name} route`}
          value={repeat ? "repeat" : "go"}
          disabled={readOnly || (optional && route === undefined)}
          options={[
            { value: "go", label: "Go to" },
            { value: "repeat", label: "Repeat" },
          ]}
          onChange={(kind) =>
            onRoute(kind === "repeat" ? toRepeat() : route ? { to: route.to } : undefined)
          }
        />
      </div>
      {repeat ? (
        <>
          <Labeled id={id} label="↩ Return to">
            <Select
              id={id}
              value={route!.to}
              disabled={readOnly}
              invalid={invalid(control)}
              options={withCurrent(
                nodeOptions(definition, returnable),
                route!.to,
                `${route!.to} (missing)`,
              )}
              onChange={(to) => onRoute({ to, repeat })}
            />
          </Labeled>
          <div className="grid grid-cols-2 gap-2">
            <Labeled id={`${id}-max`} label="Max repeats">
              <Select
                id={`${id}-max`}
                size="sm"
                value={String(repeat.max)}
                disabled={readOnly}
                options={withCurrent(
                  repeatCounts.map((count) => ({
                    value: String(count),
                    label: `×${count} · ${count + 1} visits`,
                  })),
                  String(repeat.max),
                  `×${repeat.max} (outside 1–${limits.repeats})`,
                )}
                onChange={(max) =>
                  onRoute({ to: route!.to, repeat: { ...repeat, max: Number(max) } })
                }
              />
            </Labeled>
            <Labeled id={controlId(node.id, limitControl)} label="At limit">
              <Select
                id={controlId(node.id, limitControl)}
                size="sm"
                value={repeat.atLimit}
                disabled={readOnly}
                invalid={invalid(limitControl)}
                options={withCurrent(
                  nodeOptions(definition, terminal),
                  repeat.atLimit,
                  `${repeat.atLimit} (missing or not an end or gate)`,
                )}
                onChange={(atLimit) => onRoute({ to: route!.to, repeat: { ...repeat, atLimit } })}
              />
            </Labeled>
          </div>
        </>
      ) : (
        <Select
          id={id}
          ariaLabel={`${name} destination`}
          value={route?.to ?? ""}
          disabled={readOnly}
          invalid={invalid(control)}
          options={withCurrent(
            [...(optional ? [{ value: "", label: "Not set" }] : []), ...nodeOptions(definition)],
            route?.to ?? "",
            `${route?.to ?? ""} (missing)`,
          )}
          onChange={(to) => onRoute(to === "" ? undefined : { ...route, to })}
        />
      )}
      <Problems problems={problems} nodeId={node.id} control={control} exact />
      {repeat ? (
        <Problems problems={problems} nodeId={node.id} control={limitControl} exact />
      ) : null}
    </div>
  );
}
