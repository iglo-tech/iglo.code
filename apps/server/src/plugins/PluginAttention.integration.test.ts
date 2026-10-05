import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  type PluginAttention,
  type PluginAttentionItem,
} from "@t3tools/contracts";
import { Host, type ServerPlugin, type PluginServices } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { startEnvironment, makeClient } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const plugin = (id: string, attention: PluginServices["attention"]): ServerPlugin => ({
  manifest: {
    id,
    displayName: id,
    version: "1",
    hostVersion: 1,
    requiredCapabilities: ["attention"],
    server: { tools: [], api: [], scheduleTargets: [] },
    web: { pages: [id + ".page"], navigation: [], projectActions: [], threadContext: [] },
  },
  migrations: [],
  acquire: Effect.succeed({ tools: [], api: [], scheduleTargets: [], attention }),
});
const item = (pluginId: string, id: string): PluginAttentionItem => ({
  id,
  summary: id,
  severity: "info",
  reason: "Controlled notification",
  link: { pageId: pluginId + ".page" },
});
it.live.each(["healthy", "typed failure", "invalid items"] as const)(
  "keeps authenticated attention updates with %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const failGate = yield* Deferred.make<void>();
        const healthyFirst = yield* Deferred.make<void>();
        const healthySecond = yield* Deferred.make<void>();
        const badFirst = yield* Deferred.make<void>();
        const badCleared = yield* Deferred.make<void>();
        const healthyItems = yield* Queue.unbounded<ReadonlyArray<PluginAttentionItem>>();
        const healthyStopped = yield* Deferred.make<void>();
        const good = plugin(
          "good",
          Stream.fromQueue(healthyItems).pipe(
            Stream.ensuring(Deferred.succeed(healthyStopped, undefined)),
          ),
        );
        const bad = plugin(
          "bad",
          Stream.concat(
            Stream.succeed([item("bad", "stale")]),
            Stream.fromEffect(
              Deferred.await(failGate).pipe(
                Effect.andThen(
                  scenario === "typed failure"
                    ? Effect.fail(
                        new PluginError({
                          pluginId: "bad",
                          code: "storage",
                          operation: "attention",
                          message: "Controlled source failure",
                        }),
                      )
                    : Effect.succeed([{ ...item("bad", "invalid"), summary: " " }]),
                ),
              ),
            ),
          ),
        );
        const config = {
          ...(yield* makeReplayServerConfig("attention-isolation")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(
          config,
          scenario === "healthy" ? [good] : [good, bad],
        );
        const host = Context.get(server.context, Host);
        const client = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
        const seen: PluginAttention[] = [];
        const subscriber = yield* client["plugins.attention"]({
          environmentId: host.environmentId,
        }).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.pluginId === "good") {
                if (event.items[0]?.id === "before")
                  yield* Deferred.succeed(healthyFirst, undefined);
                if (event.items[0]?.id === "after")
                  yield* Deferred.succeed(healthySecond, undefined);
              } else {
                if (event.items.length === 0) yield* Deferred.succeed(badCleared, undefined);
                else yield* Deferred.succeed(badFirst, undefined);
              }
            }),
          ),
          Effect.result,
          Effect.forkScoped,
        );
        yield* Queue.offer(healthyItems, [item("good", "before")]);
        yield* Deferred.await(healthyFirst);
        if (scenario !== "healthy") {
          yield* Deferred.await(badFirst);
          yield* Deferred.succeed(failGate, undefined);
          const result = yield* Effect.raceFirst(
            Deferred.await(badCleared).pipe(Effect.as("cleared")),
            Fiber.join(subscriber).pipe(Effect.as("terminated")),
          );
          expect(result).toBe("cleared");
          expect(seen.findLast((e) => e.pluginId === "bad")?.items).toEqual([]);
        }
        expect(yield* Deferred.isDone(healthyStopped)).toBe(false);
        yield* Queue.offer(healthyItems, [item("good", "after")]);
        yield* Deferred.await(healthySecond);
        expect(
          seen.filter((e) => e.pluginId === "good").flatMap((e) => e.items.map((i) => i.id)),
        ).toEqual(["before", "after"]);
        yield* Fiber.interrupt(subscriber);
        yield* Deferred.await(healthyStopped);
        const resumed = yield* client["plugins.attention"]({
          environmentId: host.environmentId,
        }).pipe(
          Stream.filter((e) => e.pluginId === "good"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Queue.offer(healthyItems, [item("good", "reconnect")]);
        expect((yield* Fiber.join(resumed))[0]?.items[0]?.id).toBe("reconnect");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
