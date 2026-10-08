import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

/** Explicit plugin permissions travel with the provider's authenticated MCP config. */
export class McpToolPolicy extends Context.Service<
  McpToolPolicy,
  {
    readonly readOnlyPluginTools: Effect.Effect<ReadonlyArray<string>>;
    readonly register: (ids: ReadonlyArray<string>) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/mcp/McpToolPolicy") {}

export const layer = Layer.effect(
  McpToolPolicy,
  Effect.sync(() => {
    const registrations = new Map<symbol, ReadonlyArray<string>>();
    return McpToolPolicy.of({
      readOnlyPluginTools: Effect.sync(() =>
        [...new Set([...registrations.values()].flat())].sort(),
      ),
      register: (ids) => {
        const key = Symbol();
        return Effect.acquireRelease(
          Effect.sync(() => {
            registrations.set(key, ids);
          }),
          () =>
            Effect.sync(() => {
              registrations.delete(key);
            }),
        );
      },
    });
  }),
);
