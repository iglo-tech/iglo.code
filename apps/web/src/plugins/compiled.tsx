import { web } from "@t3tools/plugin-fixture/web";
import { web as workflows } from "@t3tools/plugin-workflows/web";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { bind } from "./contributions";
import { createFixtureClient } from "./runtime";
import { createWorkflowsClient } from "./workflowsClient";

/** The single build-time composition point for trusted web modules and typed clients. */
export const compiledWebPlugins = [
  {
    manifest: web.manifest,
    bind: (environmentId: PluginWebContext["environmentId"]) =>
      bind(web, createFixtureClient(environmentId)),
  },
  {
    manifest: workflows.manifest,
    bind: (environmentId: PluginWebContext["environmentId"]) =>
      bind(workflows, createWorkflowsClient(environmentId)),
  },
];
