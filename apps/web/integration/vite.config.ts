import { defineConfig, mergeConfig } from "vite-plus";
import baseConfig from "../../../vite.config.ts";
import * as NodeURL from "node:url";
export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        "~": NodeURL.fileURLToPath(new URL("../src", import.meta.url)),
        // Node resolves gt-react to its server entry, which refuses the SPA setup the app uses.
        "gt-react": NodeURL.fileURLToPath(
          new URL("../node_modules/gt-react/dist/index.client.mjs", import.meta.url),
        ),
      },
    },
    // Real-server workflow runs boot a full environment per test.
    test: {
      environment: "node",
      fileParallelism: false,
      setupFiles: ["integration/setup.ts"],
      testTimeout: 120_000,
    },
  }),
);
