import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  getSmoothStepPath,
  useReactFlow,
  useStore,
  useStoreApi,
  type Edge,
  type EdgeProps,
  type Node as FlowCanvasNode,
  type NodeProps,
} from "@xyflow/react";
import type { PluginDesign } from "@t3tools/plugin-host-contract/web";
import { CircleAlertIcon } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { Definition, Problem } from "../contracts.ts";
import { editableKinds, kindLabels } from "./editing.ts";
import {
  autoFitViewport,
  canvasMinZoom,
  fitPadding,
  flowGraph,
  graphBounds,
  labelWidth,
  layoutFlow,
  layoutSignature,
  refitKey,
  loopPath,
  repeatLoops,
  splinePath,
  type Bounds,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type Point,
  type RepeatLoop,
} from "./flowGraph.ts";
import { stepButtonId } from "./Flow.tsx";
import { KindIcon } from "./kinds.tsx";

interface GraphActions {
  readonly removable: (stepId: string) => boolean;
  readonly movable: (stepId: string, offset: -1 | 1) => boolean;
  readonly onSelect: (stepId: string | null) => void;
  readonly onMove: (stepId: string, offset: -1 | 1) => void;
  readonly onRemove: (stepId: string) => void;
  readonly Tooltip: PluginDesign["Tooltip"] | undefined;
}
const GraphActionsContext = createContext<GraphActions | null>(null);

type StepData = {
  readonly node: FlowNode;
  readonly selected: boolean;
  readonly errors: number;
  readonly warnings: number;
};
type StepNode =
  | FlowCanvasNode<StepData, "step">
  // Empty boxes at the complete drawn bounds, because React Flow's Fit only measures nodes.
  | FlowCanvasNode<Record<string, never>, "bounds">;
type RouteData = {
  readonly edge: FlowEdge;
  readonly points: ReadonlyArray<Point> | null;
  readonly labelText: string;
  readonly fullLabel: string;
  readonly label: Point | null;
  /** For repeat back edges: the loop's vertical run and detours, clear of every box. */
  readonly loop: RepeatLoop | null;
};
type RouteEdge = Edge<RouteData, "route">;

const kindText = (kind: FlowNode["kind"]) =>
  kind === "branch"
    ? "Reviewer"
    : kind === "parallel"
      ? "Parallel"
      : kind === "missing"
        ? "Missing step"
        : kindLabels[kind];
const tileTone: Record<FlowNode["kind"], string> = {
  agent: "bg-info/10 text-info",
  branch: "bg-info/10 text-info",
  check: "bg-muted text-muted-foreground",
  decision: "bg-warning/12 text-warning",
  join: "bg-warning/12 text-warning",
  parallel: "bg-muted text-muted-foreground",
  human: "bg-success/12 text-success",
  end: "bg-muted text-muted-foreground",
  missing: "bg-transparent text-destructive",
};
const hiddenHandle: CSSProperties = { opacity: 0, pointerEvents: "none" };
/** `children` with `label` as its tooltip when the host provides tooltips; mounts on hover only. */
function WithTooltip({
  label,
  needed = true,
  children,
}: {
  readonly label: string;
  readonly needed?: boolean;
  readonly children: ReactElement;
}) {
  const Tooltip = use(GraphActionsContext)?.Tooltip;
  return Tooltip === undefined || !needed ? children : <Tooltip label={label}>{children}</Tooltip>;
}

function StepCard({
  data,
  width,
  height,
  positionAbsoluteX,
  positionAbsoluteY,
}: NodeProps<FlowCanvasNode<StepData, "step">>) {
  const actions = use(GraphActionsContext);
  const flow = useStoreApi();
  const { setCenter } = useReactFlow();
  // Keyboard focus on a box outside the visible canvas brings it into view at the same zoom.
  const reveal = () => {
    const {
      transform: [x, y, zoom],
      width: viewWidth,
      height: viewHeight,
    } = flow.getState();
    const left = positionAbsoluteX * zoom + x;
    const top = positionAbsoluteY * zoom + y;
    if (
      left >= 0 &&
      top >= 0 &&
      left + (width ?? 0) * zoom <= viewWidth &&
      top + (height ?? 0) * zoom <= viewHeight
    )
      return;
    void setCenter(positionAbsoluteX + (width ?? 0) / 2, positionAbsoluteY + (height ?? 0) / 2, {
      zoom,
    });
  };
  const { node, selected, errors, warnings } = data;
  const removable = actions?.removable(node.id) ?? false;
  const moveUp = actions?.movable(node.id, -1) ?? false;
  const moveDown = actions?.movable(node.id, 1) ?? false;
  return (
    <div
      style={{ width, height }}
      className={[
        "relative rounded-xl border bg-card text-card-foreground shadow-xs/5 transition-[border-color,box-shadow]",
        node.kind === "missing" ? "border-dashed border-destructive/60 bg-transparent" : "",
        selected
          ? "border-primary ring-3 ring-primary/24"
          : errors > 0
            ? "border-destructive/56"
            : node.kind === "missing"
              ? ""
              : "border-border",
      ].join(" ")}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        isConnectable={false}
        style={hiddenHandle}
      />
      <Handle
        type="target"
        position={Position.Right}
        id="back-in"
        isConnectable={false}
        style={hiddenHandle}
      />
      <WithTooltip
        label={`${node.title} · ${kindText(node.kind)}${node.detail === null ? "" : ` · ${node.detail}`}`}
      >
        <button
          type="button"
          id={stepButtonId(node.id)}
          aria-label={`${kindText(node.kind)}: ${node.title}`}
          aria-pressed={selected}
          onFocus={reveal}
          aria-keyshortcuts={
            [
              moveUp ? "Alt+ArrowUp" : "",
              moveDown ? "Alt+ArrowDown" : "",
              removable ? "Delete" : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onKeyDown={(event) => {
            if (event.altKey && event.key === "ArrowUp" && moveUp) {
              event.preventDefault();
              actions?.onMove(node.stepId, -1);
            } else if (event.altKey && event.key === "ArrowDown" && moveDown) {
              event.preventDefault();
              actions?.onMove(node.stepId, 1);
            } else if (removable && (event.key === "Delete" || event.key === "Backspace")) {
              event.preventDefault();
              actions?.onRemove(node.stepId);
            }
          }}
          className="nodrag nopan flex size-full cursor-pointer items-center gap-2.5 rounded-[inherit] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${tileTone[node.kind]}`}
          >
            <KindIcon kind={node.kind} className="size-4" />
          </span>
          {/* Fixed two-line metadata; markers share one column so they never add a third row. */}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">
                {node.title}
              </span>
              {errors > 0 || warnings > 0 ? (
                <span
                  className={`flex shrink-0 items-center gap-0.5 text-xs tabular-nums ${errors > 0 ? "text-destructive" : "text-warning"}`}
                >
                  <CircleAlertIcon aria-hidden className="size-3.5" />
                  <span>{errors > 0 ? errors : warnings}</span>
                  <span className="sr-only">{errors > 0 ? "problems to fix" : "warnings"}</span>
                </span>
              ) : null}
            </span>
            <span className="block truncate text-xs leading-4 text-muted-foreground">
              {kindText(node.kind)}
              {node.detail === null ? "" : ` · ${node.detail}`}
            </span>
          </span>
          {node.entry || node.runLimit ? (
            <span className="flex shrink-0 flex-col items-end gap-0.5">
              {node.entry ? (
                <span className="rounded-full border border-primary/24 px-1.5 text-[10px] font-medium leading-4 text-primary">
                  Start
                </span>
              ) : null}
              {node.runLimit ? (
                <span className="rounded-full border border-warning/32 px-1.5 text-[10px] font-medium leading-4 text-warning-foreground">
                  Run limit
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      </WithTooltip>
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        isConnectable={false}
        style={hiddenHandle}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="back-out"
        isConnectable={false}
        style={hiddenHandle}
      />
    </div>
  );
}

const strokes: Partial<Record<FlowEdge["kind"], string>> = {
  repeat: "var(--info)",
  atLimit: "var(--warning)",
};
const defaultStroke = "color-mix(in srgb, var(--muted-foreground) 64%, transparent)";
// Markers are referenced by id, so they take plain token colors.
const markerColors: Partial<Record<FlowEdge["kind"], string>> = {
  repeat: "var(--info)",
  atLimit: "var(--warning)",
};
const labelTone: Partial<Record<FlowEdge["kind"], string>> = {
  repeat: "border-info/32 text-info",
  atLimit: "border-warning/40 text-warning-foreground",
};

function RouteLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
}: EdgeProps<RouteEdge>) {
  if (data === undefined) return null;
  let path: string;
  let label: Point | null;
  let beside = false;
  if (data.loop !== null) {
    // Repeat routes leave and re-enter on the right, outside every box they pass, so the
    // return reads as a loop back up; the label sits beside the loop's vertical run.
    // A route to its own step leaves above the card's middle and returns below it.
    path = loopPath(data.loop.source, data.loop.target, data.loop.x, {
      source: data.loop.sourceDetour,
      target: data.loop.targetDetour,
    });
    label = data.labelText === "" ? null : { x: data.loop.x, y: data.loop.y };
    beside = true;
  } else if (data.points === null) {
    const [smooth, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      borderRadius: 12,
    });
    path = smooth;
    label = data.labelText === "" ? null : { x: labelX, y: labelY };
  } else {
    path = splinePath(data.points);
    label = data.label;
  }
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        style={{
          stroke: strokes[data.edge.kind] ?? defaultStroke,
          strokeWidth: 1.5,
          ...(data.edge.kind === "atLimit" ? { strokeDasharray: "5 4" } : {}),
        }}
      />
      {label === null ? null : (
        <EdgeLabelRenderer>
          <WithTooltip label={data.fullLabel}>
            <div
              tabIndex={data.fullLabel === data.labelText ? undefined : 0}
              style={{
                width: labelWidth(data.labelText),
                transform: beside
                  ? `translate(${label.x + 6}px, ${label.y}px) translateY(-50%)`
                  : `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`,
              }}
              className={`nopan pointer-events-auto absolute truncate rounded-md border bg-background px-1.5 text-center text-[11px] font-medium leading-[18px] ${labelTone[data.edge.kind] ?? "border-border text-muted-foreground"}`}
            >
              {data.labelText}
            </div>
          </WithTooltip>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { step: StepCard, bounds: () => null };
const edgeTypes = { route: RouteLine };
// The Fit button includes the complete bounds; Refit lowers the zoom floor when necessary.
const manualFit = { padding: fitPadding, maxZoom: 1 };
// App tokens drive React Flow's own chrome so light and dark themes follow the app.
const theme = {
  "--xy-background-color": "transparent",
  "--xy-background-pattern-color": "var(--border)",
  "--xy-controls-button-background-color": "var(--popover)",
  "--xy-controls-button-background-color-hover": "var(--accent)",
  "--xy-controls-button-color": "var(--foreground)",
  "--xy-controls-button-color-hover": "var(--foreground)",
  "--xy-controls-button-border-color": "var(--border)",
  "--xy-controls-box-shadow": "0 1px 2px color-mix(in srgb, black 8%, transparent)",
  "--xy-edge-stroke-default": defaultStroke,
  "--xy-attribution-background-color": "color-mix(in srgb, var(--background) 80%, transparent)",
} as CSSProperties;

const laidOut = (graph: FlowGraph, key: string) => {
  const layout = layoutFlow(graph);
  const loops = repeatLoops(graph, layout);
  return { key, layout, loops, bounds: graphBounds(graph, layout, loops) };
};

/**
 * Fit the graph, loops included, on load, when the structure changes, and when the canvas is
 * resized (narrow layouts, the inspector opening). The vertical zoom has a readable floor (see
 * `autoFitViewport`); the Fit button shows everything. The viewport is computed from the
 * layout directly, so it never waits on React Flow measuring the boxes.
 */
function Refit({ bounds, fitKey }: { readonly bounds: Bounds; readonly fitKey: string }) {
  const { setViewport } = useReactFlow();
  const store = useStoreApi();
  // Edits that only move or resize boxes must not undo the user's pan and zoom, so the effect
  // reads the latest bounds without depending on them.
  const latest = useRef(bounds);
  useEffect(() => {
    latest.current = bounds;
  });
  const ready = useStore((state) => state.panZoom !== null);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    if (!ready || width <= 0 || height <= 0) return;
    const viewport = autoFitViewport(latest.current, width, height);
    // Width fits initially; allow the Fit button to show the full height below the usual floor.
    store
      .getState()
      .setMinZoom(
        Math.min(
          canvasMinZoom,
          getViewportForBounds(latest.current, width, height, 0, 1, fitPadding).zoom,
        ),
      );
    void setViewport(viewport);
  }, [fitKey, ready, width, height, setViewport, store]);
  return null;
}

/**
 * The workflow as a top-to-bottom graph. Selecting a box selects its step; `readOnly` drops
 * mutations so the same canvas can present a run's definition snapshot. Alt+Arrow changes
 * the steps' reading order; the inspector offers the same action without a shortcut.
 */
export function Graph({
  definition,
  selected,
  problems,
  readOnly,
  onSelect,
  onMove,
  onRemove,
  Tooltip,
}: {
  readonly definition: Definition;
  readonly selected: string | null;
  readonly problems: ReadonlyArray<Problem>;
  readonly readOnly: boolean;
  readonly onSelect: (stepId: string | null) => void;
  readonly onMove?: (stepId: string, offset: -1 | 1) => void;
  readonly onRemove?: (stepId: string) => void;
  /** The host tooltip, for titles and route labels shortened to fit. */
  readonly Tooltip?: PluginDesign["Tooltip"];
}) {
  const graph = useMemo(() => flowGraph(definition), [definition]);
  // Layout is keyed on structure, not on the definition object: edits that only change text
  // (a step title, instructions) keep the previous layout instead of re-running dagre.
  const key = layoutSignature(graph);
  const fitKey = refitKey(graph);
  const [cached, setCached] = useState(() => laidOut(graph, key));
  let current = cached;
  if (cached.key !== key) {
    current = laidOut(graph, key);
    setCached(current);
  }
  const { layout, loops, bounds } = current;
  const counts = useMemo(() => {
    const byNode = new Map<string, { errors: number; warnings: number }>();
    for (const problem of problems) {
      if (problem.nodeId === undefined) continue;
      // A reviewer's problems count on its own box, keyed like the box id.
      const lane = /^branches\.(\d+)(?:\.|$)/.exec(problem.control ?? "")?.[1];
      const key = lane === undefined ? problem.nodeId : `${problem.nodeId}#${lane}`;
      const count = byNode.get(key) ?? { errors: 0, warnings: 0 };
      if (problem.severity === "error") count.errors++;
      else count.warnings++;
      byNode.set(key, count);
    }
    return byNode;
  }, [problems]);
  const nodes = useMemo<StepNode[]>(
    () => [
      ...graph.nodes.map((node): StepNode => {
        const size = layout.sizes.get(node.id)!;
        const count = counts.get(
          node.lane === undefined ? node.stepId : `${node.stepId}#${node.lane}`,
        );
        return {
          id: node.id,
          type: "step",
          position: layout.positions.get(node.id)!,
          width: size.width,
          height: size.height,
          // Sizes come from the layout. These controlled nodes are rebuilt on every change, and
          // React Flow treats a rebuilt node without `measured` as unmeasured until it resizes,
          // which these never do; declaring the size keeps the view ready to re-fit.
          measured: size,
          data: {
            node,
            selected: selected === node.id,
            errors: count?.errors ?? 0,
            warnings: count?.warnings ?? 0,
          },
        };
      }),
      ...[
        { x: bounds.x, y: bounds.y },
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      ].map((position, index): StepNode => ({
        id: `bounds:${index}`,
        type: "bounds",
        position,
        width: 1,
        height: 1,
        measured: { width: 1, height: 1 },
        selectable: false,
        focusable: false,
        data: {},
      })),
    ],
    [graph, layout, bounds, counts, selected],
  );
  const edges = useMemo<RouteEdge[]>(() => {
    const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
    return graph.edges.map((edge) => {
      const route = layout.routes.get(edge.id);
      const color = markerColors[edge.kind] ?? "var(--muted-foreground)";
      return {
        id: edge.id,
        type: "route",
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.back ? "back-out" : "out",
        targetHandle: edge.back ? "back-in" : "in",
        ariaLabel: `${edge.fullLabel || "Route"} from ${titles.get(edge.source) ?? edge.source} to ${titles.get(edge.target) ?? edge.target}`,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        data: {
          edge,
          points: route?.points ?? null,
          labelText: route?.stub?.label ?? edge.label,
          fullLabel: route?.stub?.fullLabel ?? edge.fullLabel,
          label: route?.label ?? null,
          loop: loops.get(edge.id) ?? null,
        },
      };
    });
  }, [graph, layout, loops]);
  const removableIds = useMemo(
    () =>
      new Set(
        readOnly || onRemove === undefined || definition.nodes.length <= 1
          ? []
          : definition.nodes
              .filter((node) => (editableKinds as ReadonlyArray<string>).includes(node.kind))
              .map((node) => node.id),
      ),
    [definition, readOnly, onRemove],
  );
  const stepOrder = useMemo(
    () => new Map(definition.nodes.map((node, index) => [node.id, index])),
    [definition.nodes],
  );
  const actions = useMemo<GraphActions>(
    () => ({
      removable: (id) => removableIds.has(id),
      movable: (id, offset) => {
        const index = stepOrder.get(id);
        return (
          !readOnly &&
          onMove !== undefined &&
          index !== undefined &&
          index + offset >= 0 &&
          index + offset < stepOrder.size
        );
      },
      onSelect,
      onMove: (id, offset) => onMove?.(id, offset),
      onRemove: (id) => onRemove?.(id),
      Tooltip,
    }),
    [readOnly, removableIds, stepOrder, onSelect, onMove, onRemove, Tooltip],
  );
  return (
    <GraphActionsContext value={actions}>
      <ReactFlowProvider>
        <ReactFlow<StepNode, RouteEdge>
          aria-label="Workflow graph"
          style={theme}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={canvasMinZoom}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnDoubleClick={false}
          panOnScroll
          onPaneClick={() => onSelect(null)}
          onNodeClick={(_, node) => {
            // A reviewer lane selects itself, not its group; steps use their own id.
            if (node.type === "step") onSelect(node.data.node.id);
          }}
          attributionPosition="bottom-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} position="bottom-left" fitViewOptions={manualFit} />
          <Refit bounds={bounds} fitKey={fitKey} />
        </ReactFlow>
      </ReactFlowProvider>
    </GraphActionsContext>
  );
}
