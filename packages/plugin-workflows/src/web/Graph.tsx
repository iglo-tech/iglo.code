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
  getSmoothStepPath,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node as FlowCanvasNode,
  type NodeProps,
} from "@xyflow/react";
import { CircleAlertIcon } from "lucide-react";
import { createContext, use, useEffect, useMemo, type CSSProperties } from "react";
import type { Definition, Problem } from "../contracts.ts";
import { editableKinds, kindLabels } from "./editing.ts";
import {
  flowGraph,
  layoutFlow,
  loopPath,
  repeatLoops,
  splinePath,
  type FlowEdge,
  type FlowNode,
  type Point,
} from "./flowGraph.ts";
import { stepButtonId } from "./Flow.tsx";
import { KindIcon } from "./kinds.tsx";

interface GraphActions {
  readonly readOnly: boolean;
  readonly removable: (stepId: string) => boolean;
  readonly onSelect: (stepId: string | null) => void;
  readonly onRemove: (stepId: string) => void;
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
  // An empty box at the far edge of each repeat loop and its label, so fitting the view keeps
  // loops on screen (fit only measures nodes).
  | FlowCanvasNode<Record<string, never>, "bounds">;
type RouteData = {
  readonly edge: FlowEdge;
  readonly points: ReadonlyArray<Point> | null;
  readonly label: Point | null;
  /** For repeat back edges: the x of the loop's vertical run, clear of every box it passes. */
  readonly loopX: number | null;
};
type RouteEdge = Edge<RouteData, "route">;

const kindText = (kind: FlowNode["kind"]) =>
  kind === "branch" ? "Reviewer" : kind === "missing" ? "Missing step" : kindLabels[kind];
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

function StepCard({ data, width, height }: NodeProps<FlowCanvasNode<StepData, "step">>) {
  const actions = use(GraphActionsContext);
  const { node, selected, errors, warnings } = data;
  const removable = actions?.removable(node.id) ?? false;
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
      {node.entry || node.runLimit ? (
        <span className="pointer-events-none absolute -top-2.5 left-3 flex gap-1">
          {node.entry ? (
            <span className="rounded-full border border-primary/24 bg-background px-1.5 text-[10px] font-medium leading-4 text-primary">
              Start
            </span>
          ) : null}
          {node.runLimit ? (
            <span className="rounded-full border border-warning/32 bg-background px-1.5 text-[10px] font-medium leading-4 text-warning-foreground">
              Run limit
            </span>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        id={stepButtonId(node.id)}
        aria-label={`${kindText(node.kind)}: ${node.title}`}
        aria-pressed={selected}
        aria-keyshortcuts={removable ? "Delete" : undefined}
        onKeyDown={(event) => {
          if (!removable || (event.key !== "Delete" && event.key !== "Backspace")) return;
          event.preventDefault();
          actions?.onRemove(node.stepId);
        }}
        className="nodrag nopan flex size-full cursor-pointer items-center gap-2.5 rounded-[inherit] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${tileTone[node.kind]}`}
        >
          <KindIcon kind={node.kind} className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5">{node.title}</span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">
            {kindText(node.kind)}
            {node.detail === null ? "" : ` · ${node.detail}`}
          </span>
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
      </button>
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
  if (data.loopX !== null) {
    // Repeat routes leave and re-enter on the right, outside every box they pass, so the
    // return reads as a loop back up; the label sits beside the loop's vertical run.
    path = loopPath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, data.loopX);
    label = data.edge.label === "" ? null : { x: data.loopX, y: (sourceY + targetY) / 2 };
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
    label = data.edge.label === "" ? null : { x: labelX, y: labelY };
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
          <div
            style={{
              transform: beside
                ? `translate(${label.x + 6}px, ${label.y}px) translateY(-50%)`
                : `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`,
            }}
            className={`pointer-events-none absolute whitespace-nowrap rounded-md border bg-background px-1.5 text-[11px] font-medium leading-[18px] ${labelTone[data.edge.kind] ?? "border-border text-muted-foreground"}`}
          >
            {data.edge.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { step: StepCard, bounds: () => null };
const edgeTypes = { route: RouteLine };
const fitOptions = { padding: 0.16, maxZoom: 1 };
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
} as CSSProperties;

/**
 * Re-fit when steps are added or removed, once the new boxes are measured, and when the canvas
 * is resized (narrow layouts, the inspector opening).
 */
function Refit({ signature }: { readonly signature: string }) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    if (initialized && width > 0 && height > 0) void fitView(fitOptions);
  }, [signature, initialized, width, height, fitView]);
  return null;
}

/**
 * The workflow as a top-to-bottom graph. Selecting a box selects its step; `readOnly` drops
 * removal so the same canvas can present a run's definition snapshot.
 */
export function Graph({
  definition,
  selected,
  problems,
  readOnly,
  onSelect,
  onRemove,
}: {
  readonly definition: Definition;
  readonly selected: string | null;
  readonly problems: ReadonlyArray<Problem>;
  readonly readOnly: boolean;
  readonly onSelect: (stepId: string | null) => void;
  readonly onRemove?: (stepId: string) => void;
}) {
  const graph = useMemo(() => flowGraph(definition), [definition]);
  const layout = useMemo(() => layoutFlow(graph), [graph]);
  const counts = useMemo(() => {
    const byNode = new Map<string, { errors: number; warnings: number }>();
    for (const problem of problems) {
      if (problem.nodeId === undefined) continue;
      const count = byNode.get(problem.nodeId) ?? { errors: 0, warnings: 0 };
      if (problem.severity === "error") count.errors++;
      else count.warnings++;
      byNode.set(problem.nodeId, count);
    }
    return byNode;
  }, [problems]);
  const loops = useMemo(() => repeatLoops(graph, layout), [graph, layout]);
  const nodes = useMemo<StepNode[]>(
    () => [
      ...graph.nodes.map((node): StepNode => {
        const size = layout.sizes.get(node.id)!;
        const count = node.kind === "branch" ? undefined : counts.get(node.stepId);
        return {
          id: node.id,
          type: "step",
          position: layout.positions.get(node.id)!,
          width: size.width,
          height: size.height,
          // Sizes are fixed by the layout. Controlled nodes are rebuilt on every change
          // (selection, problems); without `measured`, React Flow treats rebuilt nodes as
          // unmeasured, `useNodesInitialized` stays false and re-fitting never runs.
          measured: size,
          data: {
            node,
            selected: selected === node.stepId,
            errors: count?.errors ?? 0,
            warnings: count?.warnings ?? 0,
          },
        };
      }),
      ...[...loops].map(([id, loop]): StepNode => ({
        id: `bounds:${id}`,
        type: "bounds",
        position: { x: loop.x + 12 + loop.labelWidth, y: loop.y },
        width: 1,
        height: 1,
        measured: { width: 1, height: 1 },
        selectable: false,
        focusable: false,
        data: {},
      })),
    ],
    [graph, layout, loops, counts, selected],
  );
  const edges = useMemo<RouteEdge[]>(() => {
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
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        data: {
          edge,
          points: route?.points ?? null,
          label: route?.label ?? null,
          loopX: loops.get(edge.id)?.x ?? null,
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
  const actions = useMemo<GraphActions>(
    () => ({
      readOnly,
      removable: (id) => removableIds.has(id),
      onSelect,
      onRemove: (id) => onRemove?.(id),
    }),
    [readOnly, removableIds, onSelect, onRemove],
  );
  const signature = useMemo(() => graph.nodes.map((node) => node.id).join("\u0000"), [graph]);
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
          fitView
          fitViewOptions={fitOptions}
          minZoom={0.2}
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
            if (node.type === "step") onSelect(node.data.node.stepId);
          }}
          attributionPosition="bottom-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <Refit signature={signature} />
        </ReactFlow>
      </ReactFlowProvider>
    </GraphActionsContext>
  );
}
