import type { KeyboardEvent } from "react";
import type { Capabilities, Definition, Node, Problem } from "../contracts.ts";
import type { PageProps } from "./common.tsx";
import { editableKinds, kindLabels, routeList, type EditableKind } from "./editing.ts";

export const stepButtonId = (nodeId: string) => `wf-step-${nodeId}`;
const title = (definition: Definition, id: string) =>
  definition.nodes.find((node) => node.id === id)?.title ?? `${id} (missing)`;

/** Add a step: only kinds this client authors are enabled; others stay visibly read-only. */
export function Palette({
  props,
  capabilities,
  disabled,
  onAdd,
}: {
  readonly props: PageProps;
  readonly capabilities: Capabilities | null;
  readonly disabled: boolean;
  readonly onAdd: (kind: EditableKind) => void;
}) {
  const { Button } = props;
  const advertised = capabilities?.nodeKinds;
  return (
    <section aria-labelledby="wf-palette-title" className="flex flex-col gap-2">
      <h2 id="wf-palette-title" className="text-sm font-medium">
        Add a step
      </h2>
      <p className="text-xs text-muted-foreground">
        A new agent step is inserted after the selected step and keeps the sequence connected.
      </p>
      {(Object.keys(kindLabels) as Array<Node["kind"]>).map((kind) => {
        const supported = advertised === undefined || advertised.includes(kind);
        const editable = (editableKinds as ReadonlyArray<string>).includes(kind);
        return (
          <div key={kind} className="flex flex-col gap-0.5">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !supported || !editable}
              onClick={() => onAdd(kind as EditableKind)}
            >
              {kindLabels[kind]}
            </Button>
            {!supported ? (
              <span className="text-xs text-muted-foreground">
                Not supported by this environment
              </span>
            ) : !editable ? (
              <span className="text-xs text-muted-foreground">
                Authoring arrives in a later update
              </span>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function routeSummary(definition: Definition, node: Node): ReadonlyArray<string> {
  return routeList(definition)
    .filter((route) => route.from.id === node.id)
    .map(
      (route) =>
        `${route.label} → ${title(definition, route.to)}${
          route.repeat
            ? ` (repeat up to ${route.repeat.max}, at limit → ${title(definition, route.repeat.atLimit)})`
            : ""
        }`,
    );
}

/** Code-native flow: steps in reading order with their outgoing routes spelled out. */
export function Flow({
  props,
  definition,
  selected,
  problems,
  readOnly,
  onSelect,
  onMove,
  onRemove,
}: {
  readonly props: PageProps;
  readonly definition: Definition;
  readonly selected: string | null;
  readonly problems: ReadonlyArray<Problem>;
  readonly readOnly: boolean;
  readonly onSelect: (id: string) => void;
  readonly onMove: (id: string, offset: -1 | 1) => void;
  readonly onRemove: (id: string) => void;
}) {
  const { Button, Badge } = props;
  const keys = (node: Node, index: number) => (event: KeyboardEvent<HTMLLIElement>) => {
    if (readOnly) return;
    if (event.altKey && event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      onMove(node.id, -1);
    } else if (event.altKey && event.key === "ArrowDown" && index < definition.nodes.length - 1) {
      event.preventDefault();
      onMove(node.id, 1);
    } else if (
      (event.key === "Delete" || event.key === "Backspace") &&
      (editableKinds as ReadonlyArray<string>).includes(node.kind) &&
      definition.nodes.length > 1
    ) {
      event.preventDefault();
      onRemove(node.id);
    }
  };
  return (
    <section aria-labelledby="wf-flow-title" className="flex min-w-0 flex-col gap-2">
      <h2 id="wf-flow-title" className="text-sm font-medium">
        Flow
      </h2>
      <p id="wf-flow-hint" className="text-xs text-muted-foreground">
        Select a step to edit it. Alt+Arrow keys change the reading order; Delete removes a step.
        Routes, not order, decide what runs next.
      </p>
      <ol aria-label="Steps" className="flex flex-col gap-2">
        {definition.nodes.map((node, index) => {
          const issues = problems.filter((problem) => problem.nodeId === node.id);
          const editable = (editableKinds as ReadonlyArray<string>).includes(node.kind);
          return (
            <li
              key={node.id}
              onKeyDown={keys(node, index)}
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
                <Button
                  id={stepButtonId(node.id)}
                  variant={selected === node.id ? "default" : "ghost"}
                  size="sm"
                  ariaPressed={selected === node.id}
                  ariaLabel={`${kindLabels[node.kind]}: ${node.title}`}
                  onClick={() => onSelect(node.id)}
                >
                  {node.title || node.id}
                </Button>
                <Badge variant="outline">{kindLabels[node.kind]}</Badge>
                {definition.entry === node.id ? <Badge variant="info">Entry</Badge> : null}
                {definition.atLimit === node.id ? (
                  <Badge variant="secondary">At limit</Badge>
                ) : null}
                {node.kind === "end" ? <Badge variant="secondary">{node.outcome}</Badge> : null}
                {!editable ? <Badge variant="secondary">Read-only</Badge> : null}
                {issues.some((problem) => problem.severity === "error") ? (
                  <Badge variant="error">
                    {issues.filter((problem) => problem.severity === "error").length} to fix
                  </Badge>
                ) : issues.length ? (
                  <Badge variant="warning">Warning</Badge>
                ) : null}
              </div>
              <ul className="flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground">
                {routeSummary(definition, node).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {readOnly ? null : (
                <div className="flex flex-wrap gap-1 pl-6">
                  <Button
                    size="sm"
                    variant="ghost"
                    ariaLabel={`Move ${node.title} up`}
                    disabled={index === 0}
                    onClick={() => onMove(node.id, -1)}
                  >
                    Move up
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    ariaLabel={`Move ${node.title} down`}
                    disabled={index === definition.nodes.length - 1}
                    onClick={() => onMove(node.id, 1)}
                  >
                    Move down
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    ariaLabel={`Remove ${node.title}`}
                    disabled={!editable || definition.nodes.length === 1}
                    onClick={() => onRemove(node.id)}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Always-available textual equivalent of the flow: every route, direction and limit. */
export function RouteList({ definition }: { readonly definition: Definition }) {
  return (
    <section aria-labelledby="wf-routes-title" className="flex flex-col gap-2">
      <h2 id="wf-routes-title" className="text-sm font-medium">
        Route list
      </h2>
      <ol aria-label="Route list" className="flex flex-col gap-1 text-sm">
        <li>Start at {title(definition, definition.entry)}</li>
        {routeList(definition).map((route) => (
          <li key={`${route.from.id}:${route.control}`}>
            {route.from.title || route.from.id} — {route.label} → {title(definition, route.to)}
            {route.repeat
              ? `; repeats at most ${route.repeat.max} ${route.repeat.max === 1 ? "time" : "times"}, then at limit → ${title(definition, route.repeat.atLimit)}`
              : ""}
          </li>
        ))}
        <li>
          After {definition.maxVisits ?? 100} visits in one run →{" "}
          {title(definition, definition.atLimit)}
        </li>
      </ol>
    </section>
  );
}
