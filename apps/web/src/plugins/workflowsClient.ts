import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CatalogEntry,
  GateInput,
  CommandInput,
  LibraryInput,
  PreviewInput,
  ReadInput,
  ReplaceInput,
  SaveInput,
  StartSavedInput,
  WorkflowClient,
} from "@t3tools/plugin-workflows/contracts";
import { PluginError } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import type { ProjectId, ProviderInstanceId } from "@t3tools/plugin-host-contract/schema";
import {
  request,
  requestGuarded,
  subscribe,
  type EnvironmentRpcInput,
  type EnvironmentRpcStreamFailure,
  type EnvironmentRpcStreamValue,
  type EnvironmentSubscriptionRpcTag,
} from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  followStreamInEnvironment,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom, type AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { authorizePluginApi, availableCatalogAtom } from "./runtime";

const plugin = { id: "workflows", displayName: "Workflows" };
const settle = <A, E>(result: AtomCommandResult<A, E>): A => {
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
};
const authorize = (environmentId: EnvironmentId, method: string) =>
  authorizePluginApi(plugin, environmentId, method);

const projects = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.projects",
  execute: (input: { environmentId: EnvironmentId }) =>
    authorize(input.environmentId, "plugins.workflows.projects").pipe(
      Effect.andThen(request("plugins.workflows.projects", input)),
    ),
});
const library = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.library",
  execute: (input: LibraryInput) =>
    authorize(input.environmentId, "plugins.workflows.library").pipe(
      Effect.andThen(request("plugins.workflows.library", input)),
    ),
});
const read = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.read",
  execute: (input: ReadInput) =>
    authorize(input.environmentId, "plugins.workflows.read").pipe(
      Effect.andThen(request("plugins.workflows.read", input)),
    ),
});
const validate = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.validate",
  execute: (input: {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    definition: CatalogEntry["definition"] & object;
  }) =>
    authorize(input.environmentId, "plugins.workflows.validate").pipe(
      Effect.andThen(request("plugins.workflows.validate", input)),
    ),
});
const capabilities = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.capabilities",
  execute: (input: { environmentId: EnvironmentId; projectId: ProjectId }) =>
    authorize(input.environmentId, "plugins.workflows.capabilities").pipe(
      Effect.andThen(request("plugins.workflows.capabilities", input)),
    ),
});
const skills = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.skills",
  execute: (input: {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    providerInstanceId: ProviderInstanceId;
  }) =>
    authorize(input.environmentId, "plugins.workflows.skills").pipe(
      Effect.andThen(request("plugins.workflows.skills", input)),
    ),
});
const save = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.workflows.save",
  tag: "plugins.workflows.save",
  execute: (input: SaveInput) =>
    authorize(input.environmentId, "plugins.workflows.save").pipe(
      Effect.andThen(requestGuarded("plugins.workflows.save", input)),
    ),
});
const replace = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.workflows.replace",
  tag: "plugins.workflows.replace",
  execute: (input: ReplaceInput) =>
    authorize(input.environmentId, "plugins.workflows.replace").pipe(
      Effect.andThen(requestGuarded("plugins.workflows.replace", input)),
    ),
});
const preview = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.preview",
  execute: (input: PreviewInput) =>
    authorize(input.environmentId, "plugins.workflows.preview").pipe(
      Effect.andThen(request("plugins.workflows.preview", input)),
    ),
});
const runs = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.workflows.list",
  execute: (input: {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    before?: string | undefined;
  }) =>
    authorize(input.environmentId, "plugins.workflows.list").pipe(
      Effect.andThen(request("plugins.workflows.list", input)),
    ),
});
const startSaved = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.workflows.launch",
  tag: "plugins.workflows.launch",
  execute: (input: StartSavedInput) =>
    authorize(input.environmentId, "plugins.workflows.launch").pipe(
      Effect.andThen(requestGuarded("plugins.workflows.launch", input)),
    ),
});
const cancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.workflows.cancel",
  tag: "plugins.workflows.cancel",
  execute: (input: CommandInput) =>
    authorize(input.environmentId, "plugins.workflows.cancel").pipe(
      Effect.andThen(requestGuarded("plugins.workflows.cancel", input)),
    ),
});
const retry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.workflows.retry",
  tag: "plugins.workflows.retry",
  execute: (input: CommandInput) =>
    authorize(input.environmentId, "plugins.workflows.retry").pipe(
      Effect.andThen(requestGuarded("plugins.workflows.retry", input)),
    ),
});
const resume = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.workflows.resume",
  tag: "plugins.workflows.resume",
  execute: (input: CommandInput) =>
    authorize(input.environmentId, "plugins.workflows.resume").pipe(
      Effect.andThen(requestGuarded("plugins.workflows.resume", input)),
    ),
});
const gate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.workflows.gate",
  tag: "plugins.workflows.gate",
  execute: (input: GateInput) =>
    authorize(input.environmentId, "plugins.workflows.gate").pipe(
      Effect.andThen(requestGuarded("plugins.workflows.gate", input)),
    ),
});
const permissionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => ({
    save: get(save.permissionAtom(environmentId)),
    replace: get(replace.permissionAtom(environmentId)),
    start: get(startSaved.permissionAtom(environmentId)),
    cancel: get(cancel.permissionAtom(environmentId)),
    retry: get(retry.permissionAtom(environmentId)),
    resume: get(resume.permissionAtom(environmentId)),
    gate: get(gate.permissionAtom(environmentId)),
  })),
);

/** Whether a workflow stream API is published; an unloaded catalog waits instead of failing. */
const publication = (
  catalog: ReturnType<typeof availableCatalogAtom> extends Atom.Atom<infer A> ? A : never,
  environmentId: EnvironmentId,
  method: string,
) =>
  catalog === null
    ? "loading"
    : catalog.environmentId === environmentId &&
        catalog.plugins.some(
          (item) =>
            item.manifest.id === plugin.id &&
            item.manifest.hostVersion === 1 &&
            item.manifest.server.api.includes(method) &&
            item.status === "available",
        )
      ? "published"
      : "unpublished";
const unpublished = () =>
  Stream.fail(
    new PluginError({
      pluginId: plugin.id,
      operation: "subscribe",
      code: "unavailable",
      message: "Workflows is unavailable or disconnected in this environment.",
    }),
  );
// Keyed by the exact request so each view owns, and releases, its own subscription.
const streamFamily = <TTag extends EnvironmentSubscriptionRpcTag>(method: TTag) =>
  Atom.family((key: string) => {
    const input = JSON.parse(key) as EnvironmentRpcInput<TTag> & { environmentId: EnvironmentId };
    return connectionAtomRuntime
      .atom(
        (
          get,
        ): Stream.Stream<
          EnvironmentRpcStreamValue<TTag>,
          EnvironmentRpcStreamFailure<TTag> | PluginError,
          EnvironmentRegistry.EnvironmentRegistry
        > => {
          const state = publication(
            get(availableCatalogAtom(input.environmentId)),
            input.environmentId,
            method,
          );
          return state === "published"
            ? followStreamInEnvironment(input.environmentId, subscribe(method, input))
            : state === "loading"
              ? Stream.never
              : unpublished();
        },
      )
      .pipe(Atom.setIdleTTL(0));
  });
const runsAtom = streamFamily("plugins.workflows.subscribe");
const runAtom = streamFamily("plugins.workflows.watch");
const threadAtom = streamFamily("plugins.workflows.thread");
const listen = <A>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  onValue: (value: A) => void,
  onError: (message: string) => void,
) =>
  appAtomRegistry.subscribe(
    atom,
    (result) => {
      if (result._tag === "Success") onValue(result.value);
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        onError(error instanceof Error ? error.message : "The workflow subscription ended.");
      }
    },
    { immediate: true },
  );

/** Every call is bound to one environment; a disconnected target fails instead of falling back. */
export function createWorkflowsClient(environmentId: EnvironmentId): WorkflowClient {
  const target = <I>(input: I) => ({ environmentId, input: { ...input, environmentId } });
  return {
    subscribePermissions: (onPermissions) =>
      appAtomRegistry.subscribe(permissionsAtom(environmentId), onPermissions, { immediate: true }),
    projects: async () => settle(await projects.run(appAtomRegistry, target({}))),
    library: async (input) => settle(await library.run(appAtomRegistry, target(input))),
    read: async (input) => settle(await read.run(appAtomRegistry, target(input))),
    validate: async (input) => settle(await validate.run(appAtomRegistry, target(input))),
    save: async (input) => settle(await save.run(appAtomRegistry, target(input))),
    replace: async (input) => settle(await replace.run(appAtomRegistry, target(input))),
    capabilities: async (projectId) =>
      settle(await capabilities.run(appAtomRegistry, target({ projectId }))),
    skills: async (input) => settle(await skills.run(appAtomRegistry, target(input))),
    preview: async (input) => settle(await preview.run(appAtomRegistry, target(input))),
    startSaved: async (input) => settle(await startSaved.run(appAtomRegistry, target(input))),
    runs: async (input) => settle(await runs.run(appAtomRegistry, target(input))),
    subscribeRuns: (projectId, onRuns, onError) =>
      listen(runsAtom(JSON.stringify({ environmentId, projectId })), onRuns, onError),
    watchRun: (input, onRun, onError) =>
      listen(
        runAtom(
          JSON.stringify({
            environmentId,
            projectId: input.projectId,
            runId: input.runId,
            ...(input.historyOffset === undefined ? {} : { historyOffset: input.historyOffset }),
            ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
            ...(input.traceOffset === undefined ? {} : { traceOffset: input.traceOffset }),
          }),
        ),
        onRun,
        onError,
      ),
    watchThread: (input, onLink, onError) =>
      listen(threadAtom(JSON.stringify({ environmentId, ...input })), onLink, onError),
    cancel: async (input) => settle(await cancel.run(appAtomRegistry, target(input))),
    retry: async (input) => settle(await retry.run(appAtomRegistry, target(input))),
    resume: async (input) => settle(await resume.run(appAtomRegistry, target(input))),
    gate: async (input) => settle(await gate.run(appAtomRegistry, target(input))),
  };
}
