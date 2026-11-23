import { deriveLogicalProjectKeyFromSettings } from "@t3tools/client-runtime/state/project-grouping";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { Project } from "../types";
import { railProjectFor } from "./routeProject.logic";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const settings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const repositoryIdentity = {
  canonicalKey: "github.com/example/app",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/app.git",
  },
};
const project = (id: string, environmentId: EnvironmentId, overrides: Partial<Project> = {}) =>
  ({
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  }) satisfies Project;

it("resolves the rail's single scoped project to its member in the asked environment", () => {
  const app = project("app", local);
  const appRemote = project("app-remote", remote);
  const other = project("other", local, { repositoryIdentity: null });
  const projects = [app, appRemote, other];
  const appKey = deriveLogicalProjectKeyFromSettings(app, settings);
  const otherKey = deriveLogicalProjectKeyFromSettings(other, settings);
  const rail = (scopeKeys: ReadonlyArray<string>, environmentId: EnvironmentId) =>
    railProjectFor({ projects, scopeKeys, settings, primaryEnvironmentId: local, environmentId });

  expect(rail([appKey], local)).toBe(app.id);
  expect(rail([appKey], remote)).toBe(appRemote.id);
  expect(rail([otherKey], remote)).toBeUndefined();
  // All projects, or several, name no single project to open.
  expect(rail([], local)).toBeUndefined();
  expect(rail([appKey, otherKey], local)).toBeUndefined();
  // An archived project's scope reads as all projects, matching the sidebar.
  expect(
    railProjectFor({
      projects: [{ ...other, archivedAt: "2026-02-01T00:00:00.000Z" }],
      scopeKeys: [otherKey],
      settings,
      primaryEnvironmentId: local,
      environmentId: local,
    }),
  ).toBeUndefined();
});
