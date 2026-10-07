import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient } from "effect/http";

import { startEnvironment, origin, makeClient } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sessions from "../mcp/McpSessionRegistry.ts";
import * as ProviderSessions from "../mcp/McpProviderSession.ts";
import * as Claude from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { ProviderAdapterV2RuntimePolicy } from "../orchestration-v2/ProviderAdapter.ts";
import * as Providers from "../provider/ProviderRegistry.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const cases = [
  { driver: "claudeAgent", runtimeMode: "approval-required", allowed: true },
  { driver: "claudeAgent", runtimeMode: "full-access", allowed: true },
  { driver: "codex", runtimeMode: "approval-required", allowed: false },
  { driver: "codex", runtimeMode: "full-access", allowed: true },
  {
    driver: "claudeAgent",
    runtimeMode: "full-access",
    sandboxPolicy: { type: "readOnly" },
    allowed: false,
  },
  {
    driver: "codex",
    runtimeMode: "full-access",
    sandboxPolicy: { type: "readOnly" },
    allowed: false,
  },
  {
    driver: "codex",
    runtimeMode: "approval-required",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [] },
    allowed: true,
  },
  { driver: "opencode", runtimeMode: "approval-required", allowed: true },
] as const;

it.live.each(cases)(
  "enforces the effective MCP policy: %j",
  (policyCase) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Use the real report mutation, but without its explicit read-only allowance.
        const plugin = {
          ...fixture,
          acquire: fixture.acquire.pipe(
            Effect.map((services) => ({
              ...services,
              tools: services.tools.map((tool) => ({
                ...tool,
                permission: { ...tool.permission, allowInReadOnly: false },
              })),
            })),
          ),
        };
        const config = {
          ...(yield* makeReplayServerConfig("plugin-permission")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        if (policyCase.driver === "opencode") {
          const fs = yield* FileSystem.FileSystem;
          const binaryPath = `${config.baseDir}/opencode`;
          yield* fs.writeFileString(
            binaryPath,
            '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.0.18\\n"; else exit 1; fi\n',
          );
          yield* fs.chmod(binaryPath, 0o755);
          yield* fs.writeFileString(
            config.settingsPath,
            encode({ providers: { opencode: { binaryPath, enabled: true } } }),
          );
        }
        const server = yield* startEnvironment(config, [plugin]);
        if (policyCase.driver === "opencode") {
          yield* Context.get(server.context, Providers.ProviderRegistry).refreshInstance(
            ProviderInstanceId.make("opencode"),
          );
        }
        const host = Context.get(server.context, Host);
        const projectId = ProjectId.make("policy-project");
        const threadId = ThreadId.make("policy-thread");
        const instanceId = ProviderInstanceId.make(policyCase.driver);
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Policy",
          workspaceRoot: config.baseDir,
        });
        yield* Context.get(server.context, Threads.ThreadManagementService).dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Policy",
          createdBy: "user",
          creationSource: "web",
          modelSelection: { instanceId, model: "test-model" },
          runtimeMode: policyCase.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const runtimePolicy = {
          runtimeMode: policyCase.runtimeMode,
          interactionMode: "default",
          cwd: config.baseDir,
          ...("sandboxPolicy" in policyCase ? { sandboxPolicy: policyCase.sandboxPolicy } : {}),
        } satisfies ProviderAdapterV2RuntimePolicy;
        if (policyCase.driver === "claudeAgent") {
          const nativePolicy = Claude.claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy);
          expect(nativePolicy.tools !== undefined).toBe(!policyCase.allowed);
        }
        const credential = yield* Context.get(server.context, Sessions.McpSessionRegistry).issue({
          threadId,
          providerInstanceId: instanceId,
        });
        ProviderSessions.setMcpProviderSession({ ...credential.config, runtimePolicy });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => ProviderSessions.clearMcpProviderSession(threadId)),
        );
        if (policyCase.driver === "claudeAgent" && policyCase.allowed) {
          expect(
            Claude.claudeMcpQueryOverrides({ threadId, readOnlySandbox: false }).allowedTools,
          ).toContain("mcp__t3-code__*");
        }
        const http = Context.get(server.context, HttpClient.HttpClient);
        const headers = {
          authorization: credential.config.authorizationHeader,
          accept: "application/json, text/event-stream",
        };
        const init = yield* http.post(`${origin(server.context)}/mcp`, {
          headers,
          body: HttpBody.text(
            encode({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "policy-test", version: "1" },
              },
            }),
            "application/json",
          ),
        });
        expect(init.status).toBe(200);
        yield* init.text;
        const response = yield* http.post(`${origin(server.context)}/mcp`, {
          headers: {
            ...headers,
            "mcp-protocol-version": "2025-06-18",
            ...(init.headers["mcp-session-id"] === undefined
              ? {}
              : { "mcp-session-id": init.headers["mcp-session-id"] }),
          },
          body: HttpBody.text(
            encode({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "plugin_fixture_report",
                arguments: { id: "policy-report", summary: "Effective policy mutation" },
              },
            }),
            "application/json",
          ),
        });
        const result = yield* response.text;
        expect(response.status).toBe(200);
        expect(result).toContain(policyCase.allowed ? '"isError":false' : '"isError":true');
        if (!policyCase.allowed) expect(result).toContain('"code":"unauthorized"');
        const client = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
        const reports = yield* client["plugins.fixture.list"]({
          environmentId: host.environmentId,
        });
        expect(reports).toHaveLength(policyCase.allowed ? 1 : 0);
        if (policyCase.allowed)
          expect(reports[0]).toMatchObject({ id: "policy-report", projectId, threadId });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);
