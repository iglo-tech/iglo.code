import { defineConfig, mergeConfig } from "vite-plus";
import baseConfig from "../../../vite.config.ts";
import * as NodeURL from "node:url";
export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../src", import.meta.url)) } },
    // Real-server workflow runs boot a full environment per test.
    test: { environment: "node", fileParallelism: false, testTimeout: 120_000 },
  }),
);
