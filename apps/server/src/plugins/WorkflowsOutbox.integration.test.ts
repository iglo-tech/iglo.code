import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { Run } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);

it.live.each([255, 256])("outbox backlog of %s failures permits later healthy work", (count) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      // The fixture repository stays unchanged while seeding the backlog.
      const workspace = yield* test.core.workspace(test.scope.projectId);
      let healthyCalls = 0;
      const host = Host.of({
        ...test.core,
        workspace: () => Effect.succeed(workspace),
        launch: (input) =>
          Effect.suspend(() => {
            if (input.title === "Unavailable")
              return Effect.fail(
                new PluginError({
                  pluginId: "host",
                  code: "service",
                  operation: "launch",
                  message: "Transient outage",
                }),
              );
            healthyCalls++;
            return test.core.launch(input);
          }),
      });
      let runtime = yield* test.boot(host);
      const definition = (title: string) => ({
        ...sequence,
        nodes: sequence.nodes.map((node) => (node.kind === "agent" ? { ...node, title } : node)),
      });
      for (let index = 0; index < count; index++)
        yield* runtime.invoke("start", {
          ...test.scope,
          clientRequestId: `blocked-${index}`,
          definition: definition("Unavailable"),
          input: {},
          workspace: { type: "current" },
        });
      yield* runtime.invoke("reconcile", test.scope);
      const started = yield* runtime
        .invoke("start", {
          ...test.scope,
          clientRequestId: "healthy",
          definition: definition("Healthy"),
          input: {},
          workspace: { type: "current" },
        })
        .pipe(Effect.flatMap(decodeRun));
      for (let batch = 0; batch < 4; batch++) yield* runtime.invoke("reconcile", test.scope);
      expect(yield* test.threads.getThreadShell(started.attempts[0]!.threadId!)).not.toBeNull();
      expect(healthyCalls).toBe(1);
      yield* runtime.close;
      runtime = yield* test.boot(host);
      for (let batch = 0; batch < 3; batch++) yield* runtime.invoke("reconcile", test.scope);
      expect(yield* test.threads.getThreadShell(started.attempts[0]!.threadId!)).not.toBeNull();
      expect(healthyCalls).toBe(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
