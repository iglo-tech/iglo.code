import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Context from "effect/Context";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { Schedules, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
it.live.each(["failed", "succeeded", "succeeded before a later failure"] as const)(
  "plugin dispatch receipt %s",
  (result) =>
    Effect.scoped(
      Effect.gen(function* () {
        let acquired: Schedules["Service"] | undefined;
        let calls = 0;
        const plugin: ServerPlugin = {
          manifest: {
            id: "receipt",
            displayName: "Receipt",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["schedules"],
            server: { tools: [], api: [], scheduleTargets: ["receipt.dispatch"] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.gen(function* () {
            acquired = yield* Schedules;
            return {
              tools: [],
              api: [],
              attention: Stream.succeed([]),
              scheduleTargets: [
                {
                  id: "receipt.dispatch",
                  invoke: () =>
                    Effect.gen(function* () {
                      calls++;
                      if (result === "failed" || (result !== "succeeded" && calls > 1))
                        return yield* new PluginError({
                          pluginId: "receipt",
                          code: "service",
                          operation: "dispatch",
                          message: "deterministic dispatch failure",
                        });
                    }),
                },
              ],
            };
          }),
        };
        const config = {
          ...(yield* makeReplayServerConfig("plugin-schedule-receipt")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, [plugin]);
        const projectId = ProjectId.make("receipts");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Receipts",
          workspaceRoot: config.baseDir,
        });
        const service = acquired!;
        yield* service.upsert({
          id: "schedule",
          target: "receipt.dispatch",
          payload: { test: result },
          title: "Dispatch",
          projectId,
          enabled: false,
          schedule: { type: "interval", everyMs: 3600000 },
        });
        const first = yield* Effect.exit(service.runNow("schedule", "stable-occurrence"));
        const firstPersisted = yield* service.list();
        const retry = yield* Effect.exit(service.runNow("schedule", "stable-occurrence"));
        const retryPersisted = yield* service.list();
        expect(calls).toBe(1);
        expect(firstPersisted[0]?.lastStatus).toBe(result === "failed" ? "failed" : "succeeded");
        expect(retryPersisted[0]?.lastStatus).toBe(result === "failed" ? "failed" : "succeeded");
        expect(first._tag).toBe(result === "failed" ? "Failure" : "Success");
        expect(retry._tag).toBe(result === "failed" ? "Failure" : "Success");
        if (result === "succeeded before a later failure") {
          const later = yield* Effect.exit(service.runNow("schedule", "later-occurrence"));
          expect(later._tag).toBe("Failure");
          const original = yield* Effect.exit(service.runNow("schedule", "stable-occurrence"));
          expect(original._tag).toBe("Success");
          expect(calls).toBe(2);
          expect((yield* service.list())[0]?.lastStatus).toBe("failed");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);
