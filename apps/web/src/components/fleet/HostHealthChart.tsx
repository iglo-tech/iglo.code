import { useState, type PointerEvent } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  chartMax,
  chartPaths,
  nearestIndex,
  timeToX,
} from "./hostHealthChart.logic";

export interface HostHealthChartSeries {
  readonly label: string;
  readonly values: ReadonlyArray<number | null>;
  /** A `stroke-*` class for the line and a `bg-*` class for its legend swatch. */
  readonly strokeClassName: string;
  readonly swatchClassName: string;
}

export function HostHealthChart({
  title,
  timestamps,
  series,
  fromMs,
  toMs,
  maxGapMs,
  fixedMax,
  formatValue,
}: {
  readonly title: string;
  readonly timestamps: ReadonlyArray<number>;
  readonly series: ReadonlyArray<HostHealthChartSeries>;
  readonly fromMs: number;
  readonly toMs: number;
  readonly maxGapMs: number;
  readonly fixedMax?: number;
  readonly formatValue: (value: number) => string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [hovered, setHovered] = useState<number | null>(null);
  const input = {
    timestamps,
    series: series.map((entry) => entry.values),
    fromMs,
    toMs,
    maxGapMs,
    ...(fixedMax === undefined ? {} : { fixedMax }),
  };
  const max = chartMax(input);
  const paths = chartPaths(input, max);
  const shownIndex = hovered ?? (timestamps.length > 0 ? timestamps.length - 1 : null);
  const shownAt = shownIndex === null ? null : timestamps[shownIndex];
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    setHovered(nearestIndex(timestamps, (event.clientX - box.left) / box.width, fromMs, toMs));
  };

  return (
    <section className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-xs font-medium text-foreground">{title}</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs tabular-nums text-muted-foreground">
          {series.map((entry) => {
            const value = shownIndex === null ? null : entry.values[shownIndex];
            return (
              <span key={entry.label} className="inline-flex items-center gap-1.5">
                <span className={cn("h-1.5 w-3 rounded-full", entry.swatchClassName)} />
                {entry.label}
                <span className="text-foreground">
                  {value === null || value === undefined ? "–" : formatValue(value)}
                </span>
              </span>
            );
          })}
          {shownAt === undefined || shownAt === null ? null : (
            <time className="text-muted-foreground/70" dateTime={new Date(shownAt).toISOString()}>
              {formatDateTimeTimestamp(new Date(shownAt).toISOString(), timestampFormat)}
            </time>
          )}
        </div>
      </header>
      <div
        className="relative h-28 touch-none"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHovered(null)}
      >
        <span className="pointer-events-none absolute top-0 left-0 text-3xs tabular-nums text-muted-foreground/60">
          {formatValue(max)}
        </span>
        <svg
          className="size-full overflow-visible"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          <line
            x1={0}
            x2={CHART_WIDTH}
            y1={CHART_HEIGHT}
            y2={CHART_HEIGHT}
            className="stroke-border"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={0}
            x2={CHART_WIDTH}
            y1={CHART_HEIGHT / 2}
            y2={CHART_HEIGHT / 2}
            className="stroke-border/50"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          {paths.map((path, index) => (
            <path
              key={series[index]?.label ?? index}
              d={path}
              fill="none"
              strokeWidth={1.5}
              strokeLinejoin="round"
              className={series[index]?.strokeClassName}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hovered === null || shownAt === undefined || shownAt === null ? null : (
            <line
              x1={timeToX(shownAt, fromMs, toMs)}
              x2={timeToX(shownAt, fromMs, toMs)}
              y1={0}
              y2={CHART_HEIGHT}
              className="stroke-muted-foreground/40"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
    </section>
  );
}
