import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerDownRightIcon,
  RefreshCwIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import type { Capabilities, Definition, Node, Problem } from "../contracts.ts";
import type { PageProps } from "./common.tsx";
import {
  editableKinds,
  kindLabels,
  predicateSummary,
  repeatBadge,
  routeList,
  type EditableKind,
} from "./editing.ts";
import { KindIcon } from "./kinds.tsx";

/**
 * The focus target for a step (or reviewer lane) box. Step identities are already safe; lane
 * ids carry a `/` that is escaped injectively, so `reviews/code` never meets `reviews-code`.
 */
export const stepButtonId = (nodeId: string) =>
  `wf-step-${nodeId.replace(/[^a-zA-Z0-9-]/g, (char) =>
    char === "_" ? "__" : `_x${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}`;
const title = (definition: Definition, id: string) =>
  definition.nodes.find((node) => node.id === id)?.title || `${id} (missing)`;
const exists = (definition: Definition, id: string) =>
  definition.nodes.some((node) => node.id === id);
const editable = (node: Node) => (editableKinds as ReadonlyArray<string>).includes(node.kind);

/**
 * Add a step: only kinds this client authors and the environment advertises are enabled; the
 * rest stay visible with the reason on hover. Until capabilities load, only agent steps and
 * ends (which every backend runs) are offered.
 */
export function Palette({
  props,
  capabilities,
  capabilitiesError,
  onRetryCapabilities,
  disabled,
  onAdd,
}: {
  readonly props: PageProps;
  readonly capabilities: Capabilities | null;
  readonly capabilitiesError: string | null;
  readonly onRetryCapabilities: () => void;
  readonly disabled: boolean;
  readonly onAdd: (kind: EditableKind) => void;
}) {
  const { Button } = props;
  const advertised = capabilities?.nodeKinds;
  return (
    <nav aria-label="Add a step" className="flex flex-col gap-0.5">
      {(Object.keys(kindLabels) as Array<Node["kind"]>).map((kind) => {
        const basic = kind === "agent" || kind === "end";
        const supported = advertised === undefined ? basic : advertised.includes(kind);
        const authored = (editableKinds as ReadonlyArray<string>).includes(kind);
        const reason = !authored
          ? "Not editable in this version"
          : advertised === undefined && !basic
            ? "Loading step types…"
            : !supported
              ? "Not supported by this environment"
              : undefined;
        return (
          <Button
            key={kind}
            variant="ghost"
            size="row"
            disabled={disabled || reason !== undefined}
            {...(reason === undefined ? {} : { tooltip: reason })}
            onClick={() => onAdd(kind as EditableKind)}
          >
            <KindIcon kind={kind} />
            {kindLabels[kind]}
          </Button>
        );
      })}
      {capabilities === null && capabilitiesError !== null ? (
        <div role="alert" className="flex items-center gap-1 pl-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">
            <props.Tooltip content={capabilitiesError}>Step types unavailable</props.Tooltip>
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            ariaLabel="Retry loading step types"
            tooltip="Retry"
            onClick={onRetryCapabilities}
          >
            <RefreshCwIcon />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}

/**
 * The Routes view: steps in reading order, each with its outgoing routes on one line apiece.
 * Alt+Arrow reorders the reading order and Delete removes a step, without dragging. A run view
 * shows it read-only with each step's recorded `status`.
 */
export function RouteList({
  props,
  definition,
  selected,
  problems,
  readOnly,
  onSelect,
  onMove,
  onRemove,
  renderStatus,
}: {
  readonly props: PageProps;
  readonly definition: Definition;
  readonly selected: string | null;
  readonly problems: ReadonlyArray<Problem>;
  readonly readOnly: boolean;
  readonly onSelect: (id: string) => void;
  readonly onMove: (id: string, offset: -1 | 1) => void;
  readonly onRemove: (id: string) => void;
  readonly renderStatus?: (node: Node) => ReactNode;
}) {
  const { Button, Badge, Menu } = props;
  const routes = routeList(definition);
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
      editable(node) &&
      definition.nodes.length > 1
    ) {
      event.preventDefault();
      onRemove(node.id);
    }
  };
  return (
    <ol aria-label="Route list" className="flex flex-col gap-px">
      {definition.nodes.map((node, index) => {
        const errors = problems.filter(
          (problem) => problem.nodeId === node.id && problem.severity === "error",
        ).length;
        const warnings = problems.filter(
          (problem) => problem.nodeId === node.id && problem.severity === "warning",
        ).length;
        return (
          <li key={node.id} onKeyDown={keys(node, index)} className="flex flex-col py-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                <KindIcon kind={node.kind} className="size-4" />
              </span>
              <Button
                id={stepButtonId(node.id)}
                variant={selected === node.id ? "outline" : "ghost"}
                size="sm"
                ariaPressed={selected === node.id}
                ariaLabel={`${kindLabels[node.kind]}: ${node.title}`}
                {...(readOnly ? {} : { ariaKeyShortcuts: "Alt+ArrowUp Alt+ArrowDown Delete" })}
                onClick={() => onSelect(node.id)}
              >
                {node.title || node.id}
              </Button>
              {definition.entry === node.id ? <Badge variant="info">Start</Badge> : null}
              {definition.atLimit === node.id ? <Badge variant="warning">Run limit</Badge> : null}
              {node.kind === "end" ? <Badge variant="outline">{node.outcome}</Badge> : null}
              {renderStatus?.(node)}
              {errors > 0 ? (
                <Badge variant="error">{errors} to fix</Badge>
              ) : warnings > 0 ? (
                <Badge variant="warning">Warning</Badge>
              ) : null}
              {readOnly ? null : (
                <span className="ml-auto">
                  <Menu
                    ariaLabel={`Actions for ${node.title}`}
                    items={[
                      {
                        label: "Move up",
                        icon: <ArrowUpIcon />,
                        disabled: index === 0,
                        onSelect: () => onMove(node.id, -1),
                      },
                      {
                        label: "Move down",
                        icon: <ArrowDownIcon />,
                        disabled: index === definition.nodes.length - 1,
                        onSelect: () => onMove(node.id, 1),
                      },
                      {
                        label: "Remove",
                        icon: <Trash2Icon />,
                        destructive: true,
                        disabled: !editable(node) || definition.nodes.length === 1,
                        onSelect: () => onRemove(node.id),
                      },
                    ]}
                  />
                </span>
              )}
            </div>
            <ul className="flex flex-col pl-9 text-xs text-muted-foreground">
              {routes
                .filter((route) => route.from.id === node.id)
                .map((route) => {
                  const rule =
                    route.control.startsWith("rules.") &&
                    (node.kind === "decision" || node.kind === "join")
                      ? node.rules[Number(route.control.split(".")[1])]
                      : undefined;
                  const missing = !exists(definition, route.to);
                  const Icon = route.repeat ? Undo2Icon : CornerDownRightIcon;
                  return (
                    <li key={route.control} className="flex min-w-0 items-center gap-1.5 leading-5">
                      <Icon aria-hidden className="size-3 shrink-0 opacity-64" />
                      <span className="shrink-0">{route.label}</span>
                      {rule === undefined || route.condition === null ? null : (
                        <>
                          {" "}
                          <span className="flex min-w-0">
                            <props.Tooltip content={`If ${route.condition}`}>
                              {predicateSummary(rule.when)}
                            </props.Tooltip>
                          </span>
                        </>
                      )}{" "}
                      <span
                        className={`shrink-0 ${missing ? "text-destructive" : "text-foreground"}`}
                      >
                        {route.repeat ? "↩" : "→"} {title(definition, route.to)}
                      </span>
                      {route.repeat ? (
                        <>
                          <Badge variant="info">{repeatBadge(route.repeat)}</Badge>
                          <Badge
                            variant={exists(definition, route.repeat.atLimit) ? "warning" : "error"}
                          >
                            at limit → {title(definition, route.repeat.atLimit)}
                          </Badge>
                        </>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
