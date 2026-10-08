import { defineConfig, mergeConfig } from "vite-plus";
import baseConfig from "../../../vite.config.ts";
import * as NodeURL from "node:url";
export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../src", import.meta.url)) } },
    test: { environment: "node", fileParallelism: false },
  }),
);
