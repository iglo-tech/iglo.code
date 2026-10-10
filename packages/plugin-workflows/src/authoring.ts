import type { Host } from "@t3tools/plugin-host-contract/server";
import type { PluginError } from "@t3tools/plugin-host-contract/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Definition } from "./contracts.ts";
import { projectDefinition } from "./display.ts";
import { error } from "./encoding.ts";

const encodeTexts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeTexts = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const anyPlaceholder = /⟦protected:/;
const wholePlaceholder = /^⟦protected:([a-f0-9]{12}):(\d+)⟧$/;

/** Every string an authoring view may carry, in a stable traversal order. */
type Project<A> = (value: A, text: (value: string) => string) => A;
const projectJson: Project<unknown> = (value, text) =>
  typeof value === "string"
    ? text(value)
    : Array.isArray(value)
      ? value.map((item) => projectJson(item, text))
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, projectJson(item, text)]),
          )
        : value;
const projectAuthored: Project<Definition> = (value, text) =>
  projectDefinition(value, (item) => text(item));

export interface Protected<A> {
  readonly value: A;
  /** Placeholder to original text. */
  readonly originals: ReadonlyMap<string, string>;
}

/**
 * Replace each authored text the host would redact with a whole-string placeholder. Equal
 * secrets share a placeholder so enum values and predicate operands still match each other.
 */
const protect = <A>(project: Project<A>) =>
  Effect.fnUntraced(function* (host: Host["Service"], value: A, fingerprint: string) {
    const texts: string[] = [];
    project(value, (item) => {
      texts.push(item);
      return item;
    });
    if (texts.length === 0)
      return { value, originals: new Map<string, string>() } satisfies Protected<A>;
    const visible = yield* host
      .redact({ text: encodeTexts(texts), format: "json", threadIds: [] })
      .pipe(Effect.flatMap(decodeTexts));
    const tokens = new Map<string, string>();
    texts.forEach((item, index) => {
      if (visible[index] !== item && !tokens.has(item))
        tokens.set(item, `⟦protected:${fingerprint.slice(0, 12)}:${tokens.size}⟧`);
    });
    return {
      value: project(value, (item) => tokens.get(item) ?? item),
      originals: new Map([...tokens].map(([original, token]) => [token, original])),
    } satisfies Protected<A>;
  });
export const protectDefinition = protect(projectAuthored);
/** Schema-invalid files keep their parsed shape so repair can still preserve protected text. */
export const protectParsed = protect(projectJson);

/**
 * Restore placeholders from the catalog source whose fingerprint issued them. A placeholder
 * that was partially edited, or whose source changed, is rejected instead of saved literally.
 */
export const restoreDefinition = Effect.fnUntraced(function* (
  definition: Definition,
  originals: (
    fingerprintPrefix: string,
  ) => Effect.Effect<ReadonlyMap<string, string> | undefined, PluginError>,
) {
  const found = new Set<string>();
  projectAuthored(definition, (value) => {
    if (anyPlaceholder.test(value)) found.add(value);
    return value;
  });
  if (found.size === 0) return definition;
  const restored = new Map<string, string>();
  for (const value of found) {
    const match = wholePlaceholder.exec(value);
    if (!match)
      return yield* error(
        "restore",
        "A protected value placeholder was edited. Keep the placeholder unchanged or replace the whole value.",
      );
    const original = (yield* originals(match[1]!))?.get(value);
    if (original === undefined)
      return yield* error(
        "restore",
        "A protected value can no longer be restored because its workflow source changed. Re-enter the value.",
        "conflict",
      );
    restored.set(value, original);
  }
  return yield* decodeDefinition(
    projectAuthored(definition, (value) => restored.get(value) ?? value),
  ).pipe(
    Effect.mapError((cause) =>
      error(
        "restore",
        "Restored protected values no longer fit the workflow schema.",
        "validation",
        cause,
      ),
    ),
  );
});
