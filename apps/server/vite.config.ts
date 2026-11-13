import "vite-plus/test/config";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- tsdown needs the asset path when it reads this config.
import * as NodePath from "node:path";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { resolveTaggedSourceVersion } from "../../scripts/lib/tagged-source-version.ts";
import packageJson from "./package.json" with { type: "json" };
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";

// Inline the JavaScript graph while preserving native loaders, SDK chunks,
// and browser package assets on disk. The archive carries these externals.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

const serverManifestPath = NodePath.join(import.meta.dirname, "package.json");
// An explicit APP_VERSION wins; it can equal the manifest at a commit tagged otherwise.
const buildVersion =
  process.env.APP_VERSION?.trim() ||
  resolveTaggedSourceVersion(NodePath.join(import.meta.dirname, "../.."), packageJson.version);
const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(buildVersion) ? "nightly" : "latest";
// Official release workflows set the telemetry channel; local builds and forks use "dev".
const TELEMETRY_CHANNELS = ["stable", "nightly", "preview", "dev"];
const telemetryChannel = process.env.IGLO_CODE_TELEMETRY_CHANNEL?.trim() || "dev";
if (!TELEMETRY_CHANNELS.includes(telemetryChannel)) {
  throw new Error(
    `IGLO_CODE_TELEMETRY_CHANNEL must be one of ${TELEMETRY_CHANNELS.join(", ")}, got "${telemetryChannel}".`,
  );
}

// Emit one module graph before Bun compiles it; bundling Effect keeps one shared HTTP/auth context.
const packExecutable = process.env.IGLO_CODE_PACK_EXE === "1";

// The root config's `projects` route repo-root runs to package configs,
// including this one. Inheriting them would make this config a container.
const { projects: _rootTestProjects, ...baseTestConfig } = baseConfig.test ?? {};
// Workspace cache configuration is invalid on a package config.
const { run: _rootRunConfig, ...basePackageConfig } = baseConfig;

export default mergeConfig(
  { ...basePackageConfig, test: baseTestConfig },
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "bun scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      plugins: [
        {
          // Every server module reads its version from this manifest import.
          name: "t3code:build-version",
          load(id) {
            if (NodePath.resolve(id) !== serverManifestPath) return;
            return {
              code: JSON.stringify({ ...packageJson, version: buildVersion }),
              moduleType: "json",
            };
          },
        },
      ],
      // SEA embeds one entry; expose the history worker as a hidden subcommand.
      entry: packExecutable ? ["src/bin.ts"] : ["src/bin.ts", "src/claude-history-worker.ts"],
      outDir: packExecutable ? "dist-exe" : "dist",
      sourcemap: !packExecutable,
      clean: true,
      // jsonc-parser's UMD main requires its own files at runtime, which the bundle cannot follow.
      alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
      deps: {
        // alwaysBundle=false has no opinion; neverBundle must retain transitive native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) => isExternalCliDependency(id),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env bun\n",
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_TELEMETRY_CHANNEL__: JSON.stringify(telemetryChannel),
      },
    },
    test: {
      // Real git, sqlite and server fixtures; leave headroom so load does not stretch their waits.
      maxWorkers: "75%",
      // Vitest requires its own group for a project with a different maxWorkers.
      sequence: { sequencer: WeightedShardSequencer, groupOrder: 1 },
      setupFiles: [
        "./src/testUtils/gitConfig.setup.ts",
        "./src/testUtils/managedServiceEnv.setup.ts",
        "./src/testUtils/telemetry.setup.ts",
      ],
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
