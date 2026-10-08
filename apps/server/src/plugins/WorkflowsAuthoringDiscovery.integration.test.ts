import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Host } from "@t3tools/plugin-host-contract/server";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

it.live(
  "authoring reads cached skill snapshots while save rescans through the real host",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const requests: Array<boolean | undefined> = [];
        // Record what the plugin asks the real host for; the real host still answers.
        const host = Host.of({
          ...test.core,
          lifecycle: () => Stream.never,
          skills: (input) =>
            Effect.suspend(() => {
              requests.push(input.fresh);
              return test.core.skills(input);
            }),
        });
        const runtime = yield* test.boot(host);
        const definition = {
          ...sequence,
          id: "skilled",
          nodes: sequence.nodes.map((node) =>
            node.kind === "agent" ? { ...node, skill: "code-review" } : node,
          ),
        };
        yield* runtime.invoke("validate", { ...test.scope, definition });
        yield* runtime.invoke("library", test.scope);
        yield* runtime
          .invoke("skills", { ...test.scope, providerInstanceId: "codex" })
          .pipe(Effect.ignore);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((fresh) => fresh === false)).toBe(true);
        requests.length = 0;
        yield* runtime
          .invoke("save", { ...test.scope, definition, expectedRevision: null })
          .pipe(Effect.ignore);
        expect(requests).toContain(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);
