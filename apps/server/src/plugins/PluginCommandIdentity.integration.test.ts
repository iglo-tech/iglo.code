import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { PluginLaunchInput } from "@t3tools/plugin-host-contract/schema";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

const encodeLegacyLaunch = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ kind: Schema.Literal("launch"), input: PluginLaunchInput }),
  ),
);
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
it.live("distinct public command ids cannot alias a launch internal message receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("pr4-command-collision")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      // Only external provider process I/O is replaced; the host, launch service, receipt store and orchestration are real.
      const binaryPath = config.baseDir + "/codex-fixture";
      yield* fs.writeFileString(
        binaryPath,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
      );
      yield* fs.chmod(binaryPath, 0o755);
      yield* fs.writeFileString(
        config.settingsPath,
        yield* encodeSettings({ providers: { codex: { binaryPath } } }),
      );
      const ready = yield* Deferred.make<Host["Service"]>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "collision",
          displayName: "Collision",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(ready, yield* Host);
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      const server = yield* startEnvironment(config, [plugin]);
      const host = yield* Deferred.await(ready);
      const projectId = ProjectId.make("collision-project");
      yield* Context.get(server.context, Projects.ProjectService).create({
        projectId,
        commandId: CommandId.make("project"),
        title: "Collision",
        workspaceRoot: config.baseDir,
      });
      const launched = yield* host.launch({
        environmentId: host.environmentId,
        projectId,
        commandId: CommandId.make("launch"),
        title: "Launch",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required",
        workspace: { type: "current" },
        instruction: "Original instruction",
      });
      const target = { environmentId: host.environmentId, projectId, threadId: launched.threadId };
      yield* Context.get(server.context, Threads.ThreadManagementService)
        .streamStoredEventsFrom({
          threadId: launched.threadId,
          afterSequence: 0,
          eventType: "checkpoint-scope.created",
        })
        .pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "checkpoint-scope.created" && event.payload.kind === "root_run",
          ),
          Stream.runHead,
        );
      yield* host.send({
        ...target,
        commandId: CommandId.make("launch:initial-message"),
        instruction: "Distinct instruction",
        mode: "queue",
      });
      const records = yield* Context.get(
        server.context,
        Threads.ThreadManagementService,
      ).getThreadRecords(launched.threadId, ["messages"]);
      // Control: a fresh ordinary identity queues exactly the requested message.
      yield* host.send({
        ...target,
        commandId: CommandId.make("independent-send"),
        instruction: "Control instruction",
        mode: "queue",
      });
      const after = yield* Context.get(
        server.context,
        Threads.ThreadManagementService,
      ).getThreadRecords(launched.threadId, ["messages"]);
      expect(after.messages.some((m) => m.text === "Control instruction")).toBe(true);
      expect(records.messages.some((m) => m.text === "Distinct instruction")).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("recovers legacy pending command identities without another launch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("legacy-plugin-command")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      const binaryPath = config.baseDir + "/provider-fixture";
      yield* fs.writeFileString(
        binaryPath,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
      );
      yield* fs.chmod(binaryPath, 0o755);
      yield* fs.writeFileString(
        config.settingsPath,
        yield* encodeSettings({ providers: { codex: { binaryPath } } }),
      );
      const hosts: Host["Service"][] = [];
      const stores: Storage["Service"][] = [];
      const plugin: ServerPlugin = {
        manifest: {
          id: "collision",
          displayName: "Collision",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          hosts.push(yield* Host);
          stores.push(yield* Storage);
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      const server = yield* startEnvironment(config, [plugin]);
      const core = Context.get(server.context, Host);
      const projectId = ProjectId.make("legacy-command-project");
      yield* Context.get(server.context, Projects.ProjectService).create({
        projectId,
        commandId: CommandId.make("project"),
        title: "Legacy",
        workspaceRoot: config.baseDir,
      });
      const input = {
        environmentId: core.environmentId,
        projectId,
        commandId: CommandId.make('"fresh"'),
        title: "Legacy",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required" as const,
        workspace: { type: "current" as const },
        instruction: "Legacy instruction",
      };
      const accepted = yield* core.launch({
        ...input,
        commandId: CommandId.make('plugin:collision:"fresh"'),
      });
      const request = yield* encodeLegacyLaunch({ kind: "launch", input });
      yield* stores[0]!
        .sql`INSERT INTO host_commands (id,request,intent,result) VALUES (${input.commandId},${request},${request},NULL)`;
      expect((yield* hosts[0]!.receipt(input.commandId))?.threadId).toBe(accepted.threadId);
      yield* Fiber.interrupt(server.fiber);
      const restarted = yield* startEnvironment(config, [plugin]);
      const recovered = yield* hosts[1]!.receipt(input.commandId);
      const retried = yield* hosts[1]!.launch(input);
      expect(recovered?.threadId).toBe(accepted.threadId);
      expect(retried.threadId).toBe(accepted.threadId);
      const fresh = yield* hosts[1]!.launch({
        ...input,
        commandId: CommandId.make("fresh"),
        instruction: undefined,
      });
      expect(fresh.threadId).not.toBe(accepted.threadId);
      const rows = yield* stores[1]!.sql<{
        pending: number;
      }>`SELECT count(*) AS pending FROM host_commands WHERE result IS NULL`;
      expect(rows[0]?.pending).toBe(0);
      const records = yield* Context.get(
        restarted.context,
        Threads.ThreadManagementService,
      ).getThreadRecords(accepted.threadId, ["messages"]);
      expect(records.messages.map((m) => m.text)).toEqual(["Legacy instruction"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
