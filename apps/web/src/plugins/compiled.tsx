import { web } from "@t3tools/plugin-fixture/web";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { bind } from "./contributions";
import { createFixtureClient } from "./runtime";

/** The single build-time composition point for trusted web modules and typed clients. */
export const compiledWebPlugins = [
  {
    manifest: web.manifest,
    bind: (environmentId: PluginWebContext["environmentId"]) =>
      bind(web, createFixtureClient(environmentId)),
  },
];
