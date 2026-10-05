import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { PluginError } from "@t3tools/plugin-host-contract/schema";

const isPluginError = Schema.is(PluginError);
export const error = (
  operation: string,
  message: string,
  code: PluginError["code"] = "validation",
  cause?: unknown,
) =>
  new PluginError({
    pluginId: "workflows",
    operation,
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
export const protect = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isPluginError(cause)
        ? cause
        : error(operation, "The workflow operation could not be completed.", "service", cause),
    ),
  );
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => `${encodeJson(name)}:${canonical(item)}`)
      .join(",")}}`;
  return encodeJson(value);
}
export const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
