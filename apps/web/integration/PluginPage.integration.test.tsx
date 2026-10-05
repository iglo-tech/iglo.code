import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import { web } from "@t3tools/plugin-fixture/web";
import type { FixtureClient } from "@t3tools/plugin-fixture/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { HttpBody, HttpClient } from "effect/unstable/http";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
} from "@tanstack/react-router";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { vi } from "vite-plus/test";
import * as Projects from "../../server/src/project/ProjectService.ts";
import * as Registry from "../../../packages/plugin-host-adapter/src/PluginRegistry.ts";
import * as McpSessions from "../../server/src/mcp/McpSessionRegistry.ts";
import * as ProviderSessions from "../../server/src/mcp/McpProviderSession.ts";
import { makeReplayServerConfig } from "../../server/src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { startEnvironment, makeClient } from "../../server/src/plugins/PluginHost.testkit.ts";
import { createPluginWebContext } from "../src/plugins/context";
import { bind } from "../src/plugins/contributions";
import { PluginPageContent } from "../src/plugins/PluginPageContent";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.live(
  "hosts reports in the shell, routes their actions, and resolves only the selected environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const services = yield* Effect.forEach(["first", "second"], (name) =>
          Effect.gen(function* () {
            const config = {
              ...(yield* makeReplayServerConfig(`plugin-page-${name}`)),
              noBrowser: true,
              traceTimingEnabled: false,
            };
            const server = yield* startEnvironment(config);
            const host = Context.get(server.context, Host);
            const projectId = ProjectId.make("same-project");
            yield* Context.get(server.context, Projects.ProjectService).create({
              commandId: CommandId.make("same-project"),
              projectId,
              title: "Same name",
              workspaceRoot: config.baseDir,
            });
            const launched = yield* host.launch({
              environmentId: host.environmentId,
              projectId,
              commandId: CommandId.make("same-launch"),
              title: "Same thread",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              runtimeMode: "approval-required",
              workspace: { type: "current" },
            });
            const credential = yield* Context.get(
              server.context,
              McpSessions.McpSessionRegistry,
            ).issue({
              threadId: launched.threadId,
              providerInstanceId: ProviderInstanceId.make("codex"),
            });
            ProviderSessions.setMcpProviderSession(credential.config);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => ProviderSessions.clearMcpProviderSession(launched.threadId)),
            );
            const http = Context.get(server.context, HttpClient.HttpClient);
            const headers = {
              authorization: credential.config.authorizationHeader,
              accept: "application/json, text/event-stream",
            };
            const initialized = yield* http.post(credential.config.endpoint, {
              headers,
              body: HttpBody.text(
                encodeJson({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "page-fixture", version: "1" },
                  },
                }),
                "application/json",
              ),
            });
            yield* initialized.text;
            const response = yield* http.post(credential.config.endpoint, {
              headers: {
                ...headers,
                "mcp-protocol-version": "2025-06-18",
                ...(initialized.headers["mcp-session-id"] === undefined
                  ? {}
                  : { "mcp-session-id": initialized.headers["mcp-session-id"] }),
              },
              body: HttpBody.text(
                encodeJson({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: {
                    name: "plugin_fixture_report",
                    arguments: { id: "same-report", summary: "Needs review" },
                  },
                }),
                "application/json",
              ),
            });
            expect(response.status).toBe(200);
            expect(yield* response.text).toContain('"isError":false');
            return {
              ...server,
              host,
              projectId,
              threadId: launched.threadId,
              rpc: yield* makeClient(server.context, [
                AuthOrchestrationReadScope,
                AuthOrchestrationOperateScope,
              ]),
            };
          }),
        );
        const first = services[0]!;
        const second = services[1]!;
        expect(first.host.environmentId).not.toBe(second.host.environmentId);
        const catalog = yield* Context.get(first.context, Registry.PluginRegistry).catalog;
        const descriptor = catalog.plugins[0]!;
        const jobs = yield* Queue.unbounded<Effect.Effect<void, never, Scope.Scope>>();
        yield* Stream.fromQueue(jobs).pipe(
          Stream.runForEach((job) => job),
          Effect.forkScoped,
        );
        const send = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
          new Promise((resolve, reject) => {
            Queue.offerUnsafe(
              jobs,
              effect.pipe(
                Effect.matchCause({
                  onSuccess: (value) => {
                    resolve(value);
                  },
                  onFailure: (cause) => {
                    reject(cause);
                  },
                }),
              ),
            );
          });
        const closed = yield* Deferred.make<void>();
        let subscription: Fiber.Fiber<void> | undefined;
        let readyResolve = () => {};
        const ready = new Promise<void>((resolve) => {
          readyResolve = resolve;
        });
        const client: FixtureClient = {
          list: (input) =>
            send(
              first.rpc["plugins.fixture.list"]({
                ...input,
                environmentId: first.host.environmentId,
              }),
            ),
          resolve: (id) =>
            send(
              first.rpc["plugins.fixture.resolve"]({ environmentId: first.host.environmentId, id }),
            ),
          schedule: (id, everyMs) =>
            send(
              first.rpc["plugins.fixture.schedule"]({
                environmentId: first.host.environmentId,
                id,
                everyMs,
              }),
            ),
          subscribe: (input, onReports, onError) => {
            let cancelled = false;
            Queue.offerUnsafe(
              jobs,
              Effect.gen(function* () {
                if (cancelled) return;
                subscription = yield* first.rpc["plugins.fixture.subscribe"]({
                  ...input,
                  environmentId: first.host.environmentId,
                }).pipe(
                  Stream.runForEach((reports) =>
                    Effect.sync(() => {
                      onReports(reports);
                      readyResolve();
                    }),
                  ),
                  Effect.catch((cause) => Effect.sync(() => onError(String(cause)))),
                  Effect.ensuring(Deferred.succeed(closed, undefined)),
                  Effect.forkScoped,
                );
              }),
            );
            return () => {
              cancelled = true;
              if (subscription !== undefined)
                Queue.offerUnsafe(jobs, Fiber.interrupt(subscription).pipe(Effect.asVoid));
            };
          },
        };
        const root = createRootRoute();
        const pluginRoute = createRoute({
          getParentRoute: () => root,
          path: "/plugins/$environmentId/$pluginId/$pageId",
        });
        const threadRoute = createRoute({
          getParentRoute: () => root,
          path: "/$environmentId/$threadId",
        });
        const router = createRouter({
          routeTree: root.addChildren([pluginRoute, threadRoute]),
          history: createMemoryHistory({
            initialEntries: [`/plugins/${first.host.environmentId}/fixture/fixture.reports`],
          }),
        });
        yield* Effect.promise(() => router.load());
        const context = createPluginWebContext(
          first.host.environmentId,
          descriptor,
          first.projectId,
          first.threadId,
          router.navigate,
        );
        const contribution = { ...bind(web, client), context };
        let renderer: ReactTestRenderer | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await act(() => renderer?.unmount());
            vi.unstubAllGlobals();
          }),
        );
        yield* Effect.promise(() =>
          act(async () => {
            renderer = create(
              <PluginPageContent
                catalog={catalog}
                contributions={[contribution]}
                pluginId="fixture"
                pageId="fixture.reports"
              />,
            );
          }),
        );
        yield* Effect.promise(() =>
          act(async () => {
            await ready;
          }),
        );
        expect(renderer!.root.findAllByProps({ "data-slot": "sidebar-inset" })).toHaveLength(1);
        expect(renderer!.root.findAllByType("li")).toHaveLength(1);
        const button = (label: string) =>
          renderer!.root.findAllByType("button").find((item) => item.children.includes(label))!;
        yield* Effect.promise(() =>
          act(async () => {
            button("Open conversation").props.onClick();
            await router.latestLoadPromise;
          }),
        );
        expect(decodeURIComponent(router.state.location.pathname)).toBe(
          `/${first.host.environmentId}/${first.threadId}`,
        );
        expect(
          (yield* first.rpc["plugins.fixture.list"]({ environmentId: first.host.environmentId }))[0]
            ?.resolved,
        ).toBe(false);
        const changed = yield* Deferred.make<void>();
        yield* first.rpc["plugins.fixture.subscribe"]({
          environmentId: first.host.environmentId,
        }).pipe(
          Stream.filter((reports) => reports[0]?.resolved === true),
          Stream.take(1),
          Stream.runForEach(() => Deferred.succeed(changed, undefined)),
          Effect.forkScoped,
        );
        yield* Effect.promise(async () => {
          await act(() => {
            button("Resolve").props.onClick();
          });
        });
        yield* Deferred.await(changed);
        expect(
          (yield* first.rpc["plugins.fixture.list"]({ environmentId: first.host.environmentId }))[0]
            ?.resolved,
        ).toBe(true);
        expect(
          (yield* second.rpc["plugins.fixture.list"]({
            environmentId: second.host.environmentId,
          }))[0]?.resolved,
        ).toBe(false);
        context.navigate(contribution.projectActions[0]!.link(first.projectId));
        yield* Effect.promise(async () => {
          await router.latestLoadPromise;
        });
        expect(router.state.location.pathname).toBe(
          `/plugins/${first.host.environmentId}/fixture/fixture.reports`,
        );
        expect(router.state.location.search).toMatchObject({ pluginProjectId: first.projectId });
        yield* Effect.promise(async () => {
          await act(() => renderer!.unmount());
        });
        renderer = undefined;
        yield* Deferred.await(closed);
        yield* Effect.promise(async () => {
          await act(() => {
            renderer = create(
              <PluginPageContent
                catalog={catalog}
                contributions={[]}
                pluginId="fixture"
                pageId="fixture.reports"
              />,
            );
          });
        });
        expect(renderer!.root.findAllByType("p").flatMap((item) => item.children)).toContain(
          "This page is not included in this client build.",
        );
        yield* Fiber.interrupt(first.fiber);
        yield* Fiber.interrupt(second.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);
