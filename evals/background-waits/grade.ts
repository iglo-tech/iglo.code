export interface Row {
  readonly id: string;
  readonly sample: number;
  readonly wait: boolean | null;
  readonly expected: boolean;
}

/** A case fails when half or more of its samples answered wrong or failed. */
export function failingCases(rows: ReadonlyArray<Row>): ReadonlyArray<string> {
  const byCase = Map.groupBy(rows, (row) => row.id);
  return [...byCase]
    .filter(([, samples]) => {
      const wrong = samples.filter((row) => row.wait !== row.expected).length;
      return wrong * 2 >= samples.length;
    })
    .map(([id]) => id);
}
