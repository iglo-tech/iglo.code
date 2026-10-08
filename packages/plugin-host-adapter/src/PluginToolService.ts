import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { Host, type PluginTool } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { McpInvocationScope } from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as Sessions from "../../../apps/server/src/mcp/McpProviderSession.ts";
import * as Threads from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { exceededDispatchModeLimit } from "../../../apps/server/src/orchestration-v2/DispatchModeLimit.ts";
import * as CommandAccess from "./PluginCommandAccess.ts";

const decodeJsonObject = Schema.decodeUnknownEffect(Schema.JsonObject);
const isReadOnlySandbox = Schema.is(Schema.Struct({ type: Schema.Literal("readOnly") }));
export class PluginToolService extends Context.Service<
  PluginToolService,
  {
    readonly bind: (
      pluginId: string,
      tool: PluginTool,
    ) => (
      payload: unknown,
      invocation: McpInvocationScope,
    ) => Effect.Effect<Schema.JsonObject, PluginError>;
  }
>()("@t3tools/plugin-host-adapter/PluginToolService") {}

export const make = Effect.gen(function* () {
  const host = yield* Host;
  const threads = yield* Threads.ThreadManagementService;
  return PluginToolService.of({
    bind: (pluginId, tool) => {
      const decodeInput = Schema.decodeUnknownEffect(tool.input);
      const encodeOutput = Schema.encodeUnknownEffect(tool.output);
      return (payload, invocation) => {
        const denied = (message: string) =>
          new PluginError({ pluginId, code: "unauthorized", operation: tool.id, message });
        return Effect.gen(function* () {
          if (
            invocation.environmentId !== host.environmentId ||
            invocation.thread === undefined ||
            !invocation.capabilities.has("orchestration")
          )
            return yield* denied(
              "This plugin tool requires an authenticated thread in the selected environment.",
            );
          const caller = invocation.thread;
          const session = Sessions.readMcpProviderSession(caller.threadId);
          if (
            session === undefined ||
            session.providerSessionId !== caller.providerSessionId ||
            session.providerInstanceId !== caller.providerInstanceId
          )
            return yield* denied(
              "This provider session is no longer the thread's active MCP session.",
            );
          const projection = yield* threads.getThreadRecords(caller.threadId, []).pipe(
            Effect.mapError(
              (cause) =>
                new PluginError({
                  pluginId,
                  code: "unavailable",
                  operation: tool.id,
                  message: "The calling thread is unavailable.",
                  cause,
                }),
            ),
          );
          if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
            return yield* denied("The calling thread is archived or deleted.");
          const provider = (yield* host.providers()).find(
            (provider) => provider.instanceId === caller.providerInstanceId,
          );
          if (provider === undefined || !provider.toolsSupported)
            return yield* new PluginError({
              pluginId,
              code: "unsupported",
              operation: tool.id,
              message: provider?.reason ?? "The selected provider is unavailable.",
            });
          // Supervised Claude/OpenCode sessions can mutate. Only Codex defaults
          // to a read-only sandbox; explicit overrides take precedence.
          const policy = session.runtimePolicy;
          const readOnly =
            policy === undefined ||
            ((provider.driver === "codex" || provider.driver === "claudeAgent") &&
              (policy.sandboxPolicy === undefined
                ? provider.driver === "codex" && policy.runtimeMode === "approval-required"
                : isReadOnlySandbox(policy.sandboxPolicy)));
          if (readOnly && !tool.permission.readOnly && !tool.permission.allowInReadOnly)
            return yield* denied(
              "This mutating tool has no explicit allowance for a read-only provider session. Use an allowed permission mode.",
            );
          const input = yield* decodeInput(payload).pipe(
            Effect.mapError(
              (cause) =>
                new PluginError({
                  pluginId,
                  code: "validation",
                  operation: tool.id,
                  message: "Plugin tool arguments do not match its schema.",
                  cause,
                }),
            ),
          );
          const result = yield* tool
            .invoke(input, {
              environmentId: host.environmentId,
              projectId: projection.thread.projectId,
              threadId: caller.threadId,
              providerInstanceId: caller.providerInstanceId,
              providerSessionId: caller.providerSessionId,
              runtimeMode: policy?.runtimeMode ?? "approval-required",
            })
            .pipe(
              Effect.provideService(CommandAccess.PluginCommandAccess, {
                authorize: (action) =>
                  Effect.gen(function* () {
                    const credential = Sessions.readMcpProviderSession(caller.threadId);
                    const current = yield* threads.getThreadShell(caller.threadId).pipe(
                      Effect.mapError(
                        (cause) =>
                          new PluginError({
                            pluginId,
                            code: "unavailable",
                            operation: tool.id,
                            message: "The calling thread is unavailable.",
                            cause,
                          }),
                      ),
                    );
                    if (
                      credential?.providerSessionId !== caller.providerSessionId ||
                      credential.providerInstanceId !== caller.providerInstanceId ||
                      current === null ||
                      current.deletedAt !== null ||
                      current.archivedAt !== null ||
                      current.activeRunId === null ||
                      current.providerInstanceId !== caller.providerInstanceId
                    )
                      return yield* denied(
                        "The calling provider no longer owns an active thread run.",
                      );
                    const limits = {
                      runtimeMode: current.runtimeMode,
                      interactionMode: current.interactionMode,
                    };
                    if (
                      action.runtimeMode !== undefined &&
                      exceededDispatchModeLimit(limits, {
                        runtimeMode: action.runtimeMode,
                        interactionMode: limits.interactionMode,
                      }) !== undefined
                    )
                      return yield* denied(
                        "The requested runtime mode is broader than the calling thread's mode.",
                      );
                    if (action.threadId !== undefined) {
                      const target = yield* threads.getThreadShell(action.threadId).pipe(
                        Effect.mapError(
                          (cause) =>
                            new PluginError({
                              pluginId,
                              code: "unavailable",
                              operation: tool.id,
                              message: "The target thread is unavailable.",
                              cause,
                            }),
                        ),
                      );
                      if (
                        target !== null &&
                        exceededDispatchModeLimit(limits, target) !== undefined
                      )
                        return yield* denied(
                          "The target thread runs above the calling thread's permission modes.",
                        );
                    }
                    return limits;
                  }),
              }),
            );
          const encoded = yield* encodeOutput(result).pipe(
            Effect.mapError(
              (cause) =>
                new PluginError({
                  pluginId,
                  code: "validation",
                  operation: tool.id,
                  message: "The plugin returned a result that does not match its schema.",
                  cause,
                }),
            ),
          );
          const json = yield* decodeJsonObject(encoded).pipe(
            Effect.mapError(
              (cause) =>
                new PluginError({
                  pluginId,
                  code: "validation",
                  operation: tool.id,
                  message: "Plugin tool results must be JSON objects.",
                  cause,
                }),
            ),
          );
          return json;
        });
      };
    },
  });
});
