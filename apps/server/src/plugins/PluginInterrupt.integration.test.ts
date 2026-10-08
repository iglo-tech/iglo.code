import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

it.live.each(["retry", "restart"] as const)(
  "preserves an idle interrupt after acknowledgement loss and plugin %s",
  (recovery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const makeReady = () =>
          Deferred.make<{
            host: Host["Service"];
            storage: Storage["Service"];
          }>();
        let ready = yield* makeReady();
        const plugin: ServerPlugin = {
          manifest: {
            id: "interrupt_fixture",
            displayName: "Interrupts",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["execution", "persistence"],
            server: { tools: [], api: [], scheduleTargets: [] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.gen(function* () {
            yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
            return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
          }),
        };
        const config = {
          ...(yield* makeReplayServerConfig(`plugin-interrupt-${recovery}`)),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, []);
        const core = Context.get(server.context, Host);
        const startPlugin = () =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const context = yield* Layer.build(
              Registry.layer({
                environmentId: core.environmentId,
                directory: `${config.stateDir}/interrupt-plugin`,
                plugins: [plugin],
              }),
            ).pipe(Effect.provide(server.context), Scope.provide(scope));
            yield* Context.get(context, Registry.PluginRegistry).start;
            return { services: yield* Deferred.await(ready), scope };
          });
        let runtime = yield* startPlugin();
        let services = runtime.services;
        const projects = Context.get(server.context, Projects.ProjectService);
        const threads = Context.get(server.context, Threads.ThreadManagementService);
        const projectId = ProjectId.make("interrupt-project");
        const threadId = ThreadId.make("interrupt-thread");
        yield* projects.create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Interrupts",
          workspaceRoot: config.baseDir,
        });
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Interrupts",
          createdBy: "user",
          creationSource: "web",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const input = {
          environmentId: services.host.environmentId,
          projectId,
          threadId,
          commandId: CommandId.make("idle-interrupt"),
        };
        expect((yield* services.host.inspect(input)).runs).toEqual([]);
        // The intent survives, but the private acknowledgement does not.
        yield* services.storage
          .sql`CREATE TRIGGER fail_ack BEFORE UPDATE OF result ON host_commands BEGIN SELECT RAISE(ABORT, 'lost acknowledgement'); END`;
        expect(yield* services.host.interrupt(input).pipe(Effect.flip)).toMatchObject({
          code: "storage",
        });
        expect(yield* services.host.receipt(input.commandId)).toBeNull();
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("later-work"),
          threadId,
          messageId: MessageId.make("later-message"),
          text: "Later unrelated work",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "user",
          creationSource: "web",
        });
        const before = (yield* services.host.inspect(input)).runs;
        expect(before).toHaveLength(1);
        expect(before[0]?.status).toBe("preparing");
        yield* services.storage.sql`DROP TRIGGER fail_ack`;
        if (recovery === "restart") {
          yield* Scope.close(runtime.scope, Exit.void);
          ready = yield* makeReady();
          runtime = yield* startPlugin();
          services = runtime.services;
          expect(
            yield* core.receipt(CommandId.make("plugin:interrupt_fixture:idle-interrupt")),
          ).toBeNull();
        }
        expect(yield* services.host.interrupt(input)).toBeNull();
        expect((yield* services.host.inspect(input)).runs).toEqual(before);
        yield* Fiber.interrupt(server.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30000 },
);
