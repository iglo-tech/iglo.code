export const CHART_WIDTH = 600;
export const CHART_HEIGHT = 120;

export interface ChartInput {
  readonly timestamps: ReadonlyArray<number>;
  readonly series: ReadonlyArray<ReadonlyArray<number | null>>;
  readonly fromMs: number;
  readonly toMs: number;
  /** Samples further apart than this were not taken (the server was down), so the line breaks. */
  readonly maxGapMs: number;
  /** A fixed top, as 100 for percentages; otherwise the scale fits the peak. */
  readonly fixedMax?: number;
}

/** 1, 2 or 5 times a power of ten at or above `peak`, so axis labels read cleanly. */
export function niceMax(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalized = peak / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function chartMax(input: ChartInput): number {
  if (input.fixedMax !== undefined) return input.fixedMax;
  let peak = 0;
  for (const values of input.series) {
    for (const value of values) if (value !== null && value > peak) peak = value;
  }
  return niceMax(peak);
}

export function timeToX(timestamp: number, fromMs: number, toMs: number): number {
  const span = toMs - fromMs;
  if (span <= 0) return CHART_WIDTH;
  return Math.min(CHART_WIDTH, Math.max(0, ((timestamp - fromMs) / span) * CHART_WIDTH));
}

/** One SVG path per series, broken wherever a value is missing or samples are too far apart. */
export function chartPaths(input: ChartInput, max = chartMax(input)): ReadonlyArray<string> {
  return input.series.map((values) => {
    let path = "";
    let previousAt: number | null = null;
    for (let index = 0; index < input.timestamps.length; index += 1) {
      const at = input.timestamps[index];
      const value = values[index];
      if (at === undefined || value === null || value === undefined || at < input.fromMs) {
        previousAt = null;
        continue;
      }
      const x = timeToX(at, input.fromMs, input.toMs).toFixed(1);
      const y = (CHART_HEIGHT - (Math.min(value, max) / max) * CHART_HEIGHT).toFixed(1);
      const joined = previousAt !== null && at - previousAt <= input.maxGapMs;
      path += `${joined ? "L" : "M"}${x},${y}`;
      previousAt = at;
    }
    return path;
  });
}

/** The sample nearest to a pointer at `fraction` (0–1) of the chart's width. */
export function nearestIndex(
  timestamps: ReadonlyArray<number>,
  fraction: number,
  fromMs: number,
  toMs: number,
): number | null {
  if (timestamps.length === 0) return null;
  const target = fromMs + fraction * (toMs - fromMs);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < timestamps.length; index += 1) {
    const distance = Math.abs((timestamps[index] ?? 0) - target);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
