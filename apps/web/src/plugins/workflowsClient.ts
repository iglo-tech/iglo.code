import type { EnvironmentId } from "@t3tools/contracts";
import type {
  CatalogEntry,
  LibraryInput,
  ReadInput,
  ReplaceInput,
  SaveInput,
  WorkflowClient,
} from "@t3tools/plugin-workflows/contracts";
import type { ProjectId, ProviderInstanceId } from "@t3tools/plugin-host-contract/schema";
import { request, requestGuarded } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { authorizePluginApi } from "./runtime";

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
const permissionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => ({
    save: get(save.permissionAtom(environmentId)),
    replace: get(replace.permissionAtom(environmentId)),
  })),
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
  };
}
