import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import {
  AuthoringEntry,
  Capabilities,
  CatalogEntry,
  LibraryPage,
} from "@t3tools/plugin-workflows/contracts";
import * as HostAdapter from "@t3tools/plugin-host-adapter/host";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Settings from "../serverSettings.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import { sequence } from "./Workflows.testkit.ts";

const decodeCapabilities = Schema.decodeUnknownEffect(Capabilities);
const decodeAuthoring = Schema.decodeUnknownEffect(AuthoringEntry);
const decodeValidation = Schema.decodeUnknownEffect(CatalogEntry);
const decodeLibrary = Schema.decodeUnknownEffect(LibraryPage);

it.live.each([
  "globally-enabled",
  "globally-disabled",
  "unconfigured-default",
  "unconfigured-default-disabled",
] as const)("authoring agrees with project provider admission: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const instanceId = ProviderInstanceId.make(
        scenario === "unconfigured-default-disabled" ? "opencode" : "codex",
      );
      const definition = {
        ...sequence,
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent"
            ? { ...node, modelSelection: { ...node.modelSelection, instanceId } }
            : node,
        ),
      };
      const fs = yield* FileSystem.FileSystem;
      const otherId = ProjectId.make("provider-enabled-project");
      const otherRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "workflow-provider-enabled-",
      });
      yield* Context.get(test.context, Projects.ProjectService).create({
        commandId: CommandId.make("provider-other-project"),
        projectId: otherId,
        title: "Review",
        workspaceRoot: otherRoot,
      });
      const settings = Context.get(test.context, Settings.ServerSettingsService);
      yield* settings.updateSettings({
        providerInstances: scenario.startsWith("unconfigured-default")
          ? {}
          : {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: scenario === "globally-enabled",
                config: {},
              },
            },
        projectSettingsOverrides: {
          [test.scope.projectId]:
            scenario === "unconfigured-default-disabled"
              ? {}
              : { providerInstances: { [instanceId]: { enabled: false } } },
          [otherId]:
            scenario === "unconfigured-default"
              ? {}
              : { providerInstances: { [instanceId]: { enabled: true } } },
        },
      });
      if (scenario.startsWith("unconfigured-default"))
        expect(Object.hasOwn((yield* settings.getSettings).providerInstances, instanceId)).toBe(
          false,
        );
      const registry = Context.get(test.context, Providers.ProviderRegistry);
      const snapshot = (yield* registry.getProviders).find(
        (provider) => provider.instanceId === instanceId,
      )!;
      // Control only the external installation/auth snapshot. Settings, host mapping,
      // registered plugin, canonical publication, files and the core admission gate are real.
      const probe = Providers.ProviderRegistry.of({
        ...registry,
        getProviders: Effect.succeed([
          {
            ...snapshot,
            ...(scenario === "unconfigured-default-disabled" ? { version: "2.0.18" } : {}),
            enabled: true,
            installed: true,
            status: "ready",
            availability: "available",
            auth: { ...snapshot.auth, status: "authenticated" },
          },
        ]),
      });
      // The unused pull-request boundary fails on call. Fresh construction installs the probe
      // rather than reusing the environment's previously acquired host layer.
      const context = yield* Layer.build(
        Layer.fresh(
          HostAdapter.layer.pipe(
            Layer.provide(Receipts.layer),
            Layer.provide(Layer.mock(PullRequests.PullRequestService)({})),
          ),
        ),
      ).pipe(Effect.provide(Context.add(test.context, Providers.ProviderRegistry, probe)));
      const host = Context.get(context, Host);
      const projects = yield* host.projects();
      expect(
        projects.filter((project) => project.title === "Review").map((project) => project.id),
      ).toEqual(expect.arrayContaining([test.scope.projectId, otherId]));
      expect(otherId).not.toBe(test.scope.projectId);
      const unscoped = (yield* host.providers()).find(
        (provider) => provider.instanceId === instanceId,
      )!;
      expect(unscoped.available).toBe(true);
      const runtime = yield* test.boot(host);
      const otherScope = { ...test.scope, projectId: otherId };
      const disabled = yield* runtime
        .invoke("capabilities", test.scope)
        .pipe(Effect.flatMap(decodeCapabilities));
      const enabled = yield* runtime
        .invoke("capabilities", otherScope)
        .pipe(Effect.flatMap(decodeCapabilities));
      const disabledProvider = disabled.providers.find(
        (provider) => provider.instanceId === instanceId,
      )!;
      const enabledProvider = enabled.providers.find(
        (provider) => provider.instanceId === instanceId,
      )!;
      expect(disabledProvider).toMatchObject({ available: false, reporting: true });
      expect(disabledProvider.reason).toContain("disabled in this project");
      expect(enabledProvider).toMatchObject({ available: true, reporting: true, reason: null });
      expect(enabledProvider.models).toEqual(unscoped.models);
      expect(enabledProvider.runtimeModes).toEqual(unscoped.runtimeModes);
      const gate = yield* test.threads
        .assertProviderInstanceEnabled({
          projectId: test.scope.projectId,
          instanceId,
          commandId: CommandId.make("provider-disabled-authoring"),
        })
        .pipe(Effect.result);
      expect(gate).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ThreadManagementProviderInstanceDisabledError" },
      });
      yield* test.threads.assertProviderInstanceEnabled({
        projectId: otherId,
        instanceId,
        commandId: CommandId.make("provider-enabled-authoring"),
      });
      const validation = yield* runtime
        .invoke("validate", { ...test.scope, definition })
        .pipe(Effect.flatMap(decodeValidation));
      expect(validation.runnable).toBe(false);
      expect(validation.problems).toContainEqual(
        expect.objectContaining({
          severity: "error",
          nodeId: sequence.nodes.find((node) => node.kind === "agent")!.id,
          control: "modelSelection",
          message: expect.stringContaining("disabled in this project"),
        }),
      );
      const rejected = yield* runtime
        .invoke("save", { ...test.scope, definition, expectedRevision: null })
        .pipe(Effect.result);
      expect(rejected).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "validation",
          message: expect.stringContaining("disabled in this project"),
        },
      });
      expect(yield* fs.exists(`${test.config.baseDir}/.t3code/workflows/sequence.yaml`)).toBe(
        false,
      );
      const saved = yield* runtime
        .invoke("save", { ...otherScope, definition, expectedRevision: null })
        .pipe(Effect.flatMap(decodeAuthoring));
      expect(saved).toMatchObject({ runnable: true, problems: [], definition });
      const filename = `${otherRoot}/${saved.source}`;
      const original = yield* fs.readFileString(filename);
      const overrides = (yield* settings.getSettings).projectSettingsOverrides;
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          ...overrides,
          [test.scope.projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
          [otherId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      });
      const changed = yield* runtime
        .invoke("capabilities", otherScope)
        .pipe(Effect.flatMap(decodeCapabilities));
      expect(
        changed.providers.find((provider) => provider.instanceId === instanceId)?.available,
      ).toBe(false);
      const read = yield* runtime
        .invoke("read", { ...otherScope, source: saved.source })
        .pipe(Effect.flatMap(decodeAuthoring));
      expect(read.runnable).toBe(false);
      expect(read.problems).toEqual(validation.problems);
      const page = yield* runtime.invoke("library", otherScope).pipe(Effect.flatMap(decodeLibrary));
      expect(page.entries.find((entry) => entry.source === saved.source)?.runnable).toBe(false);
      for (const operation of ["save", "replace"] as const) {
        const failure = yield* runtime
          .invoke(operation, {
            ...otherScope,
            source: saved.source,
            fingerprint: saved.fingerprint,
            definition: { ...definition, revision: 2 },
            expectedRevision: 1,
          })
          .pipe(Effect.result);
        expect(failure).toMatchObject({ _tag: "Failure", failure: { code: "validation" } });
        expect(yield* fs.readFileString(filename)).toBe(original);
      }
      const recovered = yield* runtime
        .invoke("save", { ...test.scope, definition, expectedRevision: null })
        .pipe(Effect.flatMap(decodeAuthoring));
      expect(recovered.runnable).toBe(true);
      yield* test.threads.assertProviderInstanceEnabled({
        projectId: test.scope.projectId,
        instanceId,
        commandId: CommandId.make("provider-reenabled-authoring"),
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
