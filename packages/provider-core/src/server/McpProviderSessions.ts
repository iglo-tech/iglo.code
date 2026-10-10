/**
 * The T3 MCP credential each thread's provider session should expose to its
 * agent. The session manager writes it before a session starts; adapters read
 * it when they build provider launch options.
 *
 * @module provider-core/server/McpProviderSessions
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";
import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

const isSameSession = (
  session: McpProviderSessionConfig | undefined,
  owner: McpProviderSessionConfig,
): session is McpProviderSessionConfig =>
  session?.providerInstanceId === owner.providerInstanceId &&
  session.providerSessionId === owner.providerSessionId;

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    /** Capture `owner` before native I/O so a retired query cannot change its replacement. */
    readonly updateRuntimePolicy: (
      owner: McpProviderSessionConfig | undefined,
      runtimePolicy: ProviderAdapterV2RuntimePolicy | undefined,
    ) => Effect.Effect<void>;
    readonly invalidateRuntimePolicy: (
      owner: McpProviderSessionConfig | undefined,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
    updateRuntimePolicy: (owner, runtimePolicy) =>
      owner === undefined || runtimePolicy === undefined
        ? Effect.void
        : Ref.update(sessions, (current) => {
            const session = current.get(owner.threadId);
            if (!isSameSession(session, owner)) return current;
            return new Map(current).set(owner.threadId, { ...session, runtimePolicy });
          }),
    invalidateRuntimePolicy: (owner) =>
      owner === undefined
        ? Effect.void
        : Ref.update(sessions, (current) => {
            const session = current.get(owner.threadId);
            if (!isSameSession(session, owner)) return current;
            const { runtimePolicy: _runtimePolicy, ...config } = session;
            return new Map(current).set(owner.threadId, config);
          }),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
