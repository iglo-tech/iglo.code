/** One color per metric, so a metric reads the same on every card and chart. */
export interface HealthTone {
  readonly title: string;
  readonly tile: string;
  /** The chart's backing and its unlit dots. */
  readonly tray: string;
  readonly idle: string;
  readonly track: string;
  /** Lit dots and legend swatches. */
  readonly dot: string;
  readonly swatch: string;
}

export const HEALTH_TONES = {
  cpu: {
    title: "text-blue-600 dark:text-blue-400",
    tile: "bg-blue-500/12 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400",
    tray: "bg-blue-500/5 dark:bg-blue-500/8",
    idle: "fill-blue-500/15",
    track: "bg-blue-500/15",
    dot: "fill-blue-500",
    swatch: "bg-blue-500",
  },
  memory: {
    title: "text-emerald-600 dark:text-emerald-400",
    tile: "bg-emerald-500/12 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400",
    tray: "bg-emerald-500/5 dark:bg-emerald-500/8",
    idle: "fill-emerald-500/15",
    track: "bg-emerald-500/15",
    dot: "fill-emerald-500",
    swatch: "bg-emerald-500",
  },
  load: {
    title: "text-violet-600 dark:text-violet-400",
    tile: "bg-violet-500/12 text-violet-600 dark:bg-violet-500/20 dark:text-violet-400",
    tray: "bg-violet-500/5 dark:bg-violet-500/8",
    idle: "fill-violet-500/15",
    track: "bg-violet-500/15",
    dot: "fill-violet-500",
    swatch: "bg-violet-500",
  },
  disk: {
    title: "text-orange-600 dark:text-orange-400",
    tile: "bg-orange-500/12 text-orange-600 dark:bg-orange-500/20 dark:text-orange-400",
    tray: "bg-orange-500/5 dark:bg-orange-500/8",
    idle: "fill-orange-500/15",
    track: "bg-orange-500/15",
    dot: "fill-orange-500",
    swatch: "bg-orange-500",
  },
  network: {
    title: "text-teal-600 dark:text-teal-400",
    tile: "bg-teal-500/12 text-teal-600 dark:bg-teal-500/20 dark:text-teal-400",
    tray: "bg-teal-500/5 dark:bg-teal-500/8",
    idle: "fill-teal-500/15",
    track: "bg-teal-500/15",
    dot: "fill-teal-500",
    swatch: "bg-teal-500",
  },
  temperature: {
    title: "text-rose-600 dark:text-rose-400",
    tile: "bg-rose-500/12 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400",
    tray: "bg-rose-500/5 dark:bg-rose-500/8",
    idle: "fill-rose-500/15",
    track: "bg-rose-500/15",
    dot: "fill-rose-500",
    swatch: "bg-rose-500",
  },
  neutral: {
    title: "text-foreground",
    tile: "bg-muted text-muted-foreground",
    tray: "bg-muted/40",
    idle: "fill-muted-foreground/15",
    track: "bg-muted",
    dot: "fill-muted-foreground",
    swatch: "bg-muted-foreground",
  },
} as const satisfies Record<string, HealthTone>;

/** A second stacked series, drawn in a contrasting color on any tone's tray. */
export const SECONDARY_SERIES = {
  blue: { dot: "fill-sky-400", swatch: "bg-sky-400" },
  amber: { dot: "fill-amber-400", swatch: "bg-amber-400" },
} as const;

/** Usage bars turn warm as they fill, whatever the metric's own color. */
export function usageFillClass(percent: number | null, normal: string): string {
  if (percent === null) return "bg-muted-foreground/30";
  if (percent >= 90) return "bg-destructive";
  if (percent >= 75) return "bg-warning";
  return normal;
}
