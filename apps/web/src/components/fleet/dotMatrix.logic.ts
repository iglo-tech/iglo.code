/** Distance between dot centers, in CSS pixels. */
export const DOT_PITCH = 6;

export interface DotMatrixInput {
  readonly timestamps: ReadonlyArray<number>;
  /** Stacked bottom to top: the second series sits on the first. */
  readonly series: ReadonlyArray<ReadonlyArray<number | null>>;
  readonly fromMs: number;
  readonly toMs: number;
  /** A column with no sample repeats the one before while the last sample is this recent. */
  readonly maxGapMs: number;
  /** A fixed top, as 100 for percentages. Without one the scale fits the tallest stacked column. */
  readonly max?: number;
  /** The lowest top a fitted scale may use, as total RAM for a chart that stacks swap on it. */
  readonly floor?: number;
  readonly columns: number;
  readonly rows: number;
}

export interface DotColumn {
  /** Lit dots per series, bottom to top. */
  readonly dots: ReadonlyArray<number>;
  /** The bucket's peak per series, which a reading shows. */
  readonly values: ReadonlyArray<number | null>;
  readonly at: number;
}

/**
 * Buckets samples into columns of dots. Each column keeps its peak, so short spikes stay visible
 * at long ranges; a column with no samples stays dark unless it falls inside a sampling gap.
 */
export function dotColumns(input: DotMatrixInput): {
  readonly columns: ReadonlyArray<DotColumn | null>;
  readonly max: number;
} {
  const { columns, rows } = input;
  if (columns <= 0 || rows <= 0) return { columns: [], max: input.max ?? 1 };
  const span = input.toMs - input.fromMs;
  const peaks: Array<Array<number | null> | null> = Array.from({ length: columns }, () => null);
  const lastAt: Array<number> = Array.from({ length: columns }, () => 0);
  for (let index = 0; index < input.timestamps.length; index += 1) {
    const at = input.timestamps[index];
    if (at === undefined || at < input.fromMs || at > input.toMs || span <= 0) continue;
    const column = Math.min(columns - 1, Math.floor(((at - input.fromMs) / span) * columns));
    const values = input.series.map((series) => series[index] ?? null);
    if (values.every((value) => value === null)) continue;
    const bucket = (peaks[column] ??= values.map(() => null));
    values.forEach((value, seriesIndex) => {
      const current = bucket[seriesIndex] ?? null;
      if (value !== null && (current === null || value > current)) bucket[seriesIndex] = value;
    });
    lastAt[column] = Math.max(lastAt[column] ?? 0, at);
  }

  let peak = 0;
  for (const bucket of peaks) {
    const sum = bucket?.reduce<number>((total, value) => total + Math.max(0, value ?? 0), 0) ?? 0;
    if (sum > peak) peak = sum;
  }
  const max =
    input.max ?? (input.floor !== undefined && peak <= input.floor ? input.floor : niceMax(peak));

  const result: Array<DotColumn | null> = [];
  let previous: DotColumn | null = null;
  for (let column = 0; column < columns; column += 1) {
    const bucket = peaks[column];
    if (bucket === null || bucket === undefined) {
      const columnStart = input.fromMs + (column / columns) * span;
      const carried =
        previous !== null && columnStart - previous.at <= input.maxGapMs ? previous : null;
      result.push(carried);
      continue;
    }
    const dots: number[] = [];
    let stacked = 0;
    let lit = 0;
    for (const value of bucket) {
      stacked += Math.max(0, value ?? 0);
      const level = max > 0 ? Math.min(rows, Math.round((stacked / max) * rows)) : 0;
      dots.push(level - lit);
      lit = level;
    }
    // A sampled column always lights its bottom dot, so "idle" reads differently from "no data".
    if (lit === 0 && dots.length > 0) dots[0] = 1;
    previous = { dots, values: bucket, at: lastAt[column] ?? 0 };
    result.push(previous);
  }
  return { columns: result, max };
}

/** 1, 2 or 5 times a power of ten at or above `peak`, so a scale reads cleanly. */
export function niceMax(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalized = peak / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}
