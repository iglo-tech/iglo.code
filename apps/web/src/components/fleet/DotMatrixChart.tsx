import { useGT } from "gt-react";
import { useId, useState, type PointerEvent } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { DOT_PITCH, dotColumns, niceMax } from "./dotMatrix.logic";
import type { HealthTone } from "./healthTones";

export interface DotMatrixSeries {
  readonly label: string;
  readonly values: ReadonlyArray<number | null>;
  /** A `fill-*` class for its dots and a `bg-*` class for its legend swatch. */
  readonly dotClassName: string;
  readonly swatchClassName: string;
}

const DOT_RADIUS = 1.75;

export function DotMatrixChart({
  tone,
  timestamps,
  series,
  fromMs,
  toMs,
  maxGapMs,
  fixedMax,
  rows,
  formatValue,
  axis = true,
}: {
  readonly tone: HealthTone;
  readonly timestamps: ReadonlyArray<number>;
  /** Stacked bottom to top. */
  readonly series: ReadonlyArray<DotMatrixSeries>;
  readonly fromMs: number;
  readonly toMs: number;
  readonly maxGapMs: number;
  /** A fixed top, as 100 for percentages; otherwise the scale fits the peak. */
  readonly fixedMax?: number;
  readonly rows: number;
  readonly formatValue: (value: number) => string;
  /** Show the time axis and, under the pointer, the column's reading. */
  readonly axis?: boolean;
}) {
  const gt = useGT();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const id = useId().replace(/[^\w-]/g, "");
  const [columnCount, setColumnCount] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);

  const max = fixedMax ?? niceMax(stackedPeak(series.map((entry) => entry.values)));
  const columns = dotColumns({
    timestamps,
    series: series.map((entry) => entry.values),
    fromMs,
    toMs,
    maxGapMs,
    max,
    columns: columnCount,
    rows,
  });
  const width = columnCount * DOT_PITCH;
  const height = rows * DOT_PITCH;
  const reading = hovered === null ? null : (columns[hovered] ?? null);

  const measure = (element: HTMLDivElement) => {
    // Only the column count is stored, so resizing within a column skips a render.
    const update = () => setColumnCount(Math.max(0, Math.floor(element.clientWidth / DOT_PITCH)));
    update();
    return observeResize(element, update);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const column = Math.floor((event.clientX - box.left) / DOT_PITCH);
    setHovered(column >= 0 && column < columnCount ? column : null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={cn("rounded-lg p-2", tone.tray)}>
        <div
          ref={measure}
          className="flex touch-none justify-center"
          style={{ height }}
          onPointerMove={axis ? onPointerMove : undefined}
          onPointerLeave={axis ? () => setHovered(null) : undefined}
        >
          {columnCount === 0 ? null : (
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
              <defs>
                <pattern
                  id={`${id}-dots`}
                  width={DOT_PITCH}
                  height={DOT_PITCH}
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx={DOT_PITCH / 2} cy={DOT_PITCH / 2} r={DOT_RADIUS} />
                </pattern>
                {/* An alpha mask keeps only the dots' shape; their color comes from the rects below. */}
                <mask id={`${id}-mask`} style={{ maskType: "alpha" }}>
                  <rect width={width} height={height} fill={`url(#${id}-dots)`} />
                </mask>
              </defs>
              <g mask={`url(#${id}-mask)`}>
                <rect width={width} height={height} className={tone.idle} />
                {columns.map((column, index) => {
                  if (column === null) return null;
                  let lit = 0;
                  return column.dots.map((count, seriesIndex) => {
                    if (count <= 0) return null;
                    lit += count;
                    return (
                      <rect
                        // oxlint-disable-next-line react/no-array-index-key -- columns are positions on the time axis
                        key={`${index}:${seriesIndex}`}
                        x={index * DOT_PITCH}
                        y={height - lit * DOT_PITCH}
                        width={DOT_PITCH}
                        height={count * DOT_PITCH}
                        className={series[seriesIndex]?.dotClassName}
                        opacity={hovered === null || hovered === index ? 1 : 0.55}
                      />
                    );
                  });
                })}
                {hovered === null ? null : (
                  <rect
                    x={hovered * DOT_PITCH}
                    width={DOT_PITCH}
                    height={height}
                    className="fill-foreground/25"
                  />
                )}
              </g>
            </svg>
          )}
        </div>
      </div>
      {!axis ? null : reading !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 px-1 text-3xs tabular-nums text-muted-foreground">
          <time dateTime={new Date(reading.at).toISOString()}>
            {formatDateTimeTimestamp(new Date(reading.at).toISOString(), timestampFormat)}
          </time>
          {series.map((entry, index) => {
            const value = reading.values[index];
            return (
              <span key={entry.label} className="inline-flex items-center gap-1">
                <span className={cn("size-1.5 rounded-full", entry.swatchClassName)} />
                {entry.label}
                <span className="font-medium text-foreground">
                  {value === null || value === undefined ? "–" : formatValue(value)}
                </span>
              </span>
            );
          })}
        </div>
      ) : (
        <div className="flex justify-between px-1 text-3xs tabular-nums text-muted-foreground/70">
          {[1, 0.75, 0.5, 0.25].map((fraction) => (
            <span key={fraction}>{agoLabel((toMs - fromMs) * fraction, gt)}</span>
          ))}
          <span>{gt("now", { $context: "right edge of a time chart" })}</span>
        </div>
      )}
    </div>
  );
}

function stackedPeak(series: ReadonlyArray<ReadonlyArray<number | null>>): number {
  let peak = 0;
  const length = Math.max(0, ...series.map((values) => values.length));
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const values of series) sum += Math.max(0, values[index] ?? 0);
    if (sum > peak) peak = sum;
  }
  return peak;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function agoLabel(ms: number, gt: ReturnType<typeof useGT>): string {
  if (ms >= 2 * DAY) {
    return gt("−{count}d", { count: Number((ms / DAY).toFixed(1)), $context: "days ago, short" });
  }
  if (ms >= 2 * HOUR) {
    return gt("−{count}h", { count: Math.round(ms / HOUR), $context: "hours ago, short" });
  }
  return gt("−{count}m", { count: Math.round(ms / MINUTE), $context: "minutes ago, short" });
}
