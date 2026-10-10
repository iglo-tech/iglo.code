import { limits, type Definition, type Field, type Predicate, type Value } from "../contracts.ts";

/**
 * Typed decision editing over the canonical predicate schema. Nothing here evaluates a
 * predicate; the server chooses routes and records which rules matched.
 */
export type Operator = Predicate["op"];
export type Leaf = Predicate & { readonly path: string };
export const isGroup = (predicate: Predicate) => predicate.op === "all" || predicate.op === "any";

export const operatorLabels: Record<Exclude<Operator, "all" | "any">, string> = {
  eq: "equals",
  ne: "does not equal",
  in: "is one of",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  present: "is present",
  absent: "is absent",
};

/** Comparisons the server accepts for a field type (numeric order needs a number, `in` text). */
export function operatorsFor(
  field: Field | undefined,
): ReadonlyArray<Exclude<Operator, "all" | "any">> {
  switch (field?.type) {
    case "number":
      return ["eq", "ne", "gt", "gte", "lt", "lte", "present", "absent"];
    case "string":
    case "enum":
      return ["eq", "ne", "in", "present", "absent"];
    default:
      return ["eq", "ne", "present", "absent"];
  }
}

/** A starting operand that already matches the field's type. */
export function defaultValue(field: Field | undefined): Value {
  switch (field?.type) {
    case "number":
      return 0;
    case "boolean":
      return true;
    case "enum":
      return field.values?.[0] ?? "";
    default:
      return "";
  }
}

/** A leaf for `path`, keeping the operator and operand when they still fit the field. */
export function leafFor(path: string, field: Field | undefined, previous?: Predicate): Predicate {
  const allowed = operatorsFor(field);
  const op =
    previous && previous.op !== "all" && previous.op !== "any" && allowed.includes(previous.op)
      ? previous.op
      : "eq";
  if (op === "present" || op === "absent") return { op, path };
  if (op === "in") return { op, path, values: [defaultValue(field)] };
  const value = previous?.value;
  const fits =
    value !== undefined &&
    (field?.type === "number"
      ? typeof value === "number"
      : field?.type === "boolean"
        ? typeof value === "boolean"
        : field?.type === "enum"
          ? typeof value === "string" && (field.values?.includes(value) ?? false)
          : typeof value === "string");
  return { op, path, value: fits ? value : defaultValue(field) };
}

/** Change a leaf's operator, carrying its operand across when the shape allows it. */
export function withOperator(leaf: Predicate, op: Operator, field: Field | undefined): Predicate {
  const path = leaf.path ?? "";
  if (op === "present" || op === "absent") return { op, path };
  const first = leaf.values?.[0] ?? leaf.value ?? defaultValue(field);
  if (op === "in") return { op, path, values: leaf.values ?? [first] };
  return { op, path, value: first };
}

export const firstLeaf = (fields: ReadonlyMap<string, Field>): Predicate => {
  const [path, field] = [...fields][0] ?? ["", undefined];
  return leafFor(path, field);
};

/** Index path of a term inside a rule's predicate; `[]` is the root. */
export type TermPath = ReadonlyArray<number>;
export const termControl = (rule: number, path: TermPath) =>
  [`rules.${rule}.when`, ...path].join(".");

export function updateTerm(
  predicate: Predicate,
  path: TermPath,
  update: (term: Predicate) => Predicate,
): Predicate {
  if (path.length === 0) return update(predicate);
  const [index, ...rest] = path;
  return {
    ...predicate,
    terms: (predicate.terms ?? []).map((term, position) =>
      position === index ? updateTerm(term, rest, update) : term,
    ),
  };
}
export function removeTerm(predicate: Predicate, path: TermPath): Predicate {
  const parent = path.slice(0, -1);
  const index = path.at(-1);
  return updateTerm(predicate, parent, (group) => ({
    ...group,
    terms: (group.terms ?? []).filter((_, position) => position !== index),
  }));
}
/** Add a term to the group at `path`; a single condition becomes a Match all group first. */
export function addTerm(predicate: Predicate, path: TermPath, term: Predicate): Predicate {
  return updateTerm(predicate, path, (target) =>
    isGroup(target)
      ? { ...target, terms: [...(target.terms ?? []), term] }
      : { op: "all", terms: [target, term] },
  );
}

export function countTerms(predicate: Predicate): number {
  return 1 + (predicate.terms ?? []).reduce((total, term) => total + countTerms(term), 0);
}
/** Terms a decision may hold in total, across all of its rules. */
export const termLimit = limits.predicateTerms;
/** Values one "is one of" condition may list (the canonical schema's bound). */
export const inValueLimit = 32;
/** Nesting levels a rule may use; the root counts as the first. */
export const depthLimit = limits.predicateDepth;

const operand = (value: Value) => (typeof value === "string" ? `"${value}"` : String(value));
/**
 * Plain-language reading of a saved predicate. Ordinary comparisons on optional fields say
 * that they are false when the field is absent, which is how the server evaluates them.
 */
export function readsAs(
  predicate: Predicate,
  fields: ReadonlyMap<string, Field> | null = null,
  nested = false,
): string {
  if (isGroup(predicate)) {
    const terms = predicate.terms ?? [];
    const joined = terms
      .map((term) => readsAs(term, fields, true))
      .join(predicate.op === "all" ? " and " : " or ");
    return nested && terms.length > 1 ? `(${joined})` : joined;
  }
  const path = predicate.path ?? "";
  const field = fields?.get(path);
  const name = fields !== null && field === undefined ? `${path} (missing field)` : path;
  if (predicate.op === "present" || predicate.op === "absent")
    return `${name} ${operatorLabels[predicate.op]}`;
  const compared =
    predicate.op === "in"
      ? `${name} is one of ${(predicate.values ?? []).map(operand).join(", ")}`
      : `${name} ${operatorLabels[predicate.op as keyof typeof operatorLabels]} ${predicate.value === undefined ? "(no value)" : operand(predicate.value)}`;
  return field !== undefined && !field.required
    ? `${compared} (false when ${path} is absent)`
    : compared;
}

/**
 * Field picker labels: a field's own name when no other option shares it, otherwise its path,
 * with a reviewer's field led by the reviewer's title.
 */
export function fieldLabels(
  paths: ReadonlyArray<string>,
  definition: Definition,
): ReadonlyMap<string, string> {
  const last = (path: string) => path.split(".").at(-1) ?? path;
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(last(path), (counts.get(last(path)) ?? 0) + 1);
  const branchTitle = (id: string) =>
    definition.nodes
      .flatMap((node) => (node.kind === "parallel" ? node.branches : []))
      .find((branch) => branch.id === id)?.title ?? id;
  return new Map(
    paths.map((path) => {
      if (counts.get(last(path)) === 1) return [path, last(path)];
      const branch = /^branches\.([^.]+)\.(.+)$/.exec(path);
      return [path, branch ? `${branchTitle(branch[1]!)} · ${branch[2]}` : path];
    }),
  );
}
