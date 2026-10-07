import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Definition, Run, RunSummary } from "@t3tools/plugin-workflows/contracts";
import { sequence, completed } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import * as Settings from "../serverSettings.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.live.each(["sensitive-environment", "github-token", "bitbucket-control"] as const)(
  "redacts known fixture-only settings secrets from accepted workflow reports: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const settings = Context.get(test.context, Settings.ServerSettingsService);
        // Fabricated fixture data; no real accounts, user state or credentials are consulted.
        const marker = 'private"fixture\nsensitive-marker';
        if (scenario === "sensitive-environment") {
          const previous = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...previous.providerInstances,
              redaction_fixture: {
                driver: ProviderDriverKind.make("codex"),
                enabled: false,
                config: {},
                environment: [{ name: "FIXTURE_ONLY_VALUE", value: marker, sensitive: true }],
              },
            },
          });
          const client = Settings.redactServerSettingsForClient(yield* settings.getSettings);
          expect(client.providerInstances.redaction_fixture?.environment?.[0]?.value).toBe("");
        } else if (scenario === "github-token") {
          yield* settings.updateSettings({ github: { tokens: { "fixture.invalid": marker } } });
          expect(
            Settings.redactServerSettingsForClient(yield* settings.getSettings).github.tokens[
              "fixture.invalid"
            ],
          ).not.toBe(marker);
        } else yield* settings.updateSettings({ bitbucket: { accessToken: marker } });
        const host = Host.of({ ...test.core, lifecycle: () => Stream.never });
        const runtime = yield* test.boot(host);
        const definition = yield* decodeDefinition({
          ...sequence,
          nodes: sequence.nodes.map((node) =>
            node.kind === "agent"
              ? { ...node, report: { fields: [{ name: "value", type: "string", required: true }] } }
              : node,
          ),
        });
        const start = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition,
            clientRequestId: "start",
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", test.scope);
        const tool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
        yield* tool.invoke(
          { ...completed, data: { value: marker } },
          {
            ...test.scope,
            threadId: start.attempts[0]!.threadId!,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "fixture",
            runtimeMode: "approval-required",
          },
        );
        const visible = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.close;
        const rebooted = yield* test.boot(host);
        const retained = yield* rebooted
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));

        expect(visible.attempts[0]!.report!.data.value).toBe("[redacted]");
        expect(retained.attempts[0]!.report!.data.value).toBe("[redacted]");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["numeric-match", "numeric-control"] as const)(
  "keeps valid numeric workflow input displayable: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const settings = Context.get(test.context, Settings.ServerSettingsService);
        // Numeric fixture token is fake, stored only in this isolated temporary environment.
        yield* settings.updateSettings({ bitbucket: { accessToken: "86420975" } });
        const host = Host.of({ ...test.core, lifecycle: () => Stream.never });
        const runtime = yield* test.boot(host);
        const result = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition: sequence,
            clientRequestId: "numeric",
            input: {
              amount: scenario === "numeric-match" ? 86420975 : 86420976,
              note: "86420975",
              confirmed: true,
            },
            workspace: { type: "current" },
          })
          .pipe(Effect.result);
        const summaries = yield* runtime
          .invoke("list", test.scope)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RunSummary))));
        expect(summaries).toHaveLength(1);
        const read = yield* runtime
          .invoke("get", { ...test.scope, runId: summaries[0]!.id })
          .pipe(Effect.result);
        yield* runtime.close;
        const restarted = yield* test.boot(host);
        const retained = yield* restarted
          .invoke("get", { ...test.scope, runId: summaries[0]!.id })
          .pipe(Effect.result);
        expect(result._tag).toBe("Success");
        expect(read._tag).toBe("Success");
        expect(retained._tag).toBe("Success");
        if (read._tag === "Success" && retained._tag === "Success") {
          const before = yield* decodeRun(read.success);
          const after = yield* decodeRun(retained.success);
          const amount = scenario === "numeric-match" ? 86420975 : 86420976;
          expect(before.input.amount).toBe(amount);
          expect(after.input.amount).toBe(amount);
          expect(before.input.note).toBe("[redacted]");
          expect(after.input.note).toBe("[redacted]");
          expect(after.input.confirmed).toBe(true);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
