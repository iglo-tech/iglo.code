import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Definition } from "@t3tools/plugin-workflows/contracts";
import * as Catalog from "../../../../packages/plugin-workflows/src/Catalog.ts";

const count = Number(process.argv[2]);
const valid = process.argv[3] === "valid";
const projectId = ProjectId.make("validation");
const environmentId = EnvironmentId.make("validation");
const definition = Schema.decodeUnknownSync(Definition)({
  version: 1,
  id: "complexity",
  revision: 1,
  title: "Complexity",
  entry: "d0",
  atLimit: "gate",
  nodes: [
    ...Array.from({ length: count }, (_, index) => {
      const next = index + 1 < count ? `d${index + 1}` : valid ? "gate" : `d${index}`;
      return {
        id: `d${index}`,
        title: "Decision",
        kind: "decision",
        source: "source",
        rules: [{ when: { op: "eq", path: "data.ready", value: true }, route: { to: next } }],
        otherwise: { to: next },
      };
    }),
    {
      id: "source",
      title: "Source",
      kind: "agent",
      modelSelection: { instanceId: "codex", model: "fixture" },
      runtimeMode: "approval-required",
      instruction: "Source",
      report: { fields: [{ name: "ready", type: "boolean", required: true }] },
      next: { to: "gate" },
    },
    { id: "gate", kind: "human", title: "Gate", approve: { to: "end" }, changes: { to: "end" } },
    { id: "end", kind: "end", title: "End", outcome: "completed" },
  ],
});
await Effect.runPromise(
  Effect.gen(function* () {
    const catalog = yield* Catalog.Catalog;
    process.send?.({ type: "begin" });
    const result = yield* catalog.validate({ environmentId, projectId }, definition);
    process.send?.({ type: "result", runnable: result.runnable, reasons: result.reasons }, () =>
      process.disconnect(),
    );
  }).pipe(
    Effect.provide(
      Catalog.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(Host)({
              environmentId,
              projects: () =>
                Effect.succeed([
                  { id: projectId, title: "Validation", workspaceRoot: import.meta.dirname },
                ]),
              providers: () =>
                Effect.succeed([
                  {
                    instanceId: ProviderInstanceId.make("codex"),
                    driver: "codex",
                    toolsSupported: true,
                    available: true,
                    runtimeModes: ["approval-required"],
                    reason: null,
                  },
                ]),
            }),
          ),
        ),
      ),
    ),
  ),
);
