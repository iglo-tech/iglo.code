import "vite-plus/test/config";
import { defineConfig, type Plugin } from "vite-plus";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const DOM_TEST_ENVIRONMENT_ALLOWLIST: Array<string> = [];

const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@t3tools/client-runtime",
    message:
      "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@pierre/diffs/react",
    importNames: ["CodeView"],
    message: "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
  },
];

const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

const RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS = {
  name: "lucide-react",
  importNames: [
    "GitMerge",
    "GitMergeIcon",
    "GitPullRequest",
    "GitPullRequestIcon",
    "GitPullRequestArrow",
    "GitPullRequestArrowIcon",
    "GitPullRequestClosed",
    "GitPullRequestClosedIcon",
    "GitPullRequestDraft",
    "GitPullRequestDraftIcon",
    "GitPullRequestCreate",
    "GitPullRequestCreateIcon",
    "GitPullRequestCreateArrow",
    "GitPullRequestCreateArrowIcon",
  ],
  message:
    "Pick a glyph by meaning from PullRequestGlyph in apps/web/src/components/pullRequest/pullRequestIcons.tsx so every surface draws the same pull request the same way.",
};

/**
 * `vp test` from the repo root runs this config, not apps/web/vite.config.ts or
 * apps/web/integration/vite.config.ts, so the web integration tests would render uncompiled
 * JSX. Under test only, components (.tsx) under apps/web/src and packages/plugin-workflows/src/web
 * compile as in the app (compiler bailouts and crashes included). `react({ compiler: true })` from
 * @vitejs/plugin-react is not used: it compiles only for client-consumer environments, which
 * would skip Vitest's node environment.
 */
const loadWebReactCompiler = async (): Promise<Plugin> => {
  const webRequire = NodeModule.createRequire(new URL("./apps/web/package.json", import.meta.url));
  // Non-literal specifier resolves from apps/web; its types do not resolve from the repo root.
  const {
    transform,
  }: {
    transform: (
      filename: string,
      code: string,
      options: { jsx: "preserve"; reactCompiler: boolean; sourcemap: boolean },
    ) => Promise<{
      code: string;
      map?: unknown;
      fatal: boolean;
      errors: ReadonlyArray<{ message: string; codeframe?: string | null }>;
    }>;
  } = await import(NodeURL.pathToFileURL(webRequire.resolve("oxc-transform-react")).href);
  return {
    name: "t3code:test-react-compiler",
    enforce: "pre",
    transform: {
      filter: {
        id: {
          include: [
            /\/apps\/web\/src\/.*\.tsx$/,
            /\/packages\/plugin-workflows\/src\/web\/.*\.tsx$/,
          ],
          exclude: [/\.test\.tsx$/, /\/node_modules\//],
        },
        code: /\b[A-Z]|\buse/,
      },
      async handler(code, id) {
        const result = await transform(id.split("?")[0]!, code, {
          jsx: "preserve",
          reactCompiler: true,
          sourcemap: true,
        });
        const diagnostics = result.errors.map(
          (error) => `${error.message}${error.codeframe ? `\n${error.codeframe}` : ""}`,
        );
        if (result.fatal)
          this.error(diagnostics.join("\n\n") || "React Compiler transform failed.");
        return { code: result.code, map: result.map as never };
      },
    },
  };
};

export default defineConfig({
  plugins: [process.env.VITEST ? loadWebReactCompiler() : null],
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/.t3/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
    ],
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      // Macroscope's glob-per-line ignore grammar, not Markdown: formatting
      // it rewrites `*` as `_` and joins lines.
      ".macroscope/ignore.md",
      ".alchemy",
      "dist",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "*.icon/**",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        { paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS] },
      ],
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "warn",
      "t3code/no-low-value-comments": "error",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-native-title-tooltip": "error",
      "t3code/no-raw-mcp-registration": "error",
      "t3code/no-test-in-loop": "error",
      "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }],
      "t3code/no-unscoped-has": "error",
      "t3code/namespace-node-imports": "error",
      "t3code/prefer-catch-tags": "error",
      "t3code/prefer-effect-fn": "error",
      "t3code/require-centered-scroll-gutter": "error",
      "t3code/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: ["packages/plugin-*/src/**"],
        excludeFiles: ["packages/plugin-host-adapter/**", "packages/plugin-host-contract/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "**/apps/**",
                    "**/client-runtime/**",
                    "**/plugin-host-adapter/**",
                    "**/contracts/**",
                    "**/shared/**",
                    "@t3tools/client-runtime",
                    "@t3tools/client-runtime/**",
                    "@t3tools/plugin-host-adapter",
                    "@t3tools/plugin-host-adapter/**",
                    "@t3tools/contracts",
                    "@t3tools/contracts/**",
                    "@t3tools/shared",
                    "@t3tools/shared/**",
                  ],
                  message:
                    "Plugins use @t3tools/plugin-host-contract and their own contracts. T3 implementation dependencies belong in the host adapter.",
                },
              ],
            },
          ],
        },
      },
      {
        files: [
          "**/*.{test,spec,testkit}.{ts,tsx}",
          "**/{test,tests,testkit,testing,fixtures,integration}/**",
          "packages/provider-testing/**",
        ],
        rules: { "t3code/prefer-effect-fn": "off" },
      },
      {
        files: ["apps/**/src/**", "packages/**/src/**"],
        excludeFiles: DOM_TEST_ENVIRONMENT_ALLOWLIST,
        rules: { "t3code/no-dom-test-environment": "error" },
      },
      {
        files: ["packages/client-runtime/src/state/**", "apps/web/src/**"],
        rules: { "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: false }] },
      },
      {
        files: [
          "packages/client-runtime/src/state/runtime.ts",
          "packages/client-runtime/src/state/vcsAction.ts",
        ],
        rules: {
          "t3code/no-rpc-permission-bypass": [
            "error",
            { allowGuardInstallation: true, allowRawClientAccess: false },
          ],
        },
      },
      {
        // These clients are session metadata and device streams.
        files: [
          "apps/web/src/components/settings/ConnectionsSettings.tsx",
          "apps/web/src/components/device/DevicePhoneViewport.tsx",
          "apps/web/src/components/device/DeviceDuoViewport.tsx",
        ],
        rules: { "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }] },
      },
      {
        files: ["packages/client-runtime/src/connection/outdatedHostUpdate.ts"],
        rules: { "t3code/no-rpc-permission-bypass": "off" },
      },
      {
        files: [
          "packages/client-runtime/src/rpc/**",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "t3code/no-rpc-permission-bypass": "off" },
      },
      {
        files: ["packages/shared/src/HostProcess.ts"],
        rules: { "t3code/no-global-process-runtime": "off" },
      },
      {
        // The `t3` npm launcher is published as plain, dependency-free Node.
        files: ["scripts/npm-launcher/**"],
        rules: {
          "t3code/no-global-process-runtime": "off",
          "t3code/namespace-node-imports": "off",
        },
      },
      {
        files: ["apps/server/src/mcp/McpHttpServer.ts"],
        rules: { "t3code/no-raw-mcp-registration": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: RESTRICTED_UI_VARIANT_PATTERNS,
            },
          ],
        },
      },
      {
        files: ["apps/web/src/components/pullRequest/pullRequestIcons.tsx"],
        rules: { "eslint/no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }] },
      },
      {
        // React commits state set in a raw ResizeObserver callback after the paint, so derived
        // layout lands a frame late. observeResize flushes every observed resize in one render.
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/lib/observeResize.ts",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "t3code/no-raw-resize-observer": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "t3code/no-outset-state-indicators": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        // Third-party marks (brand logos, the macOS permission panes, Codex's Computer Use
        // mark) must keep their exact colors, so the files that hold them are exempt.
        files: ["apps/web/src/components/Icons.tsx", "apps/web/src/components/JetBrainsIcons.tsx"],
        rules: { "shadcn/no-raw-colors": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "shadcn/require-static-classes": "error",
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                "transition",
                "rounded-[inherit]",
                "gap-[0.33em]",
                "px-[0.5em]",
                "rounded-[0.5em]",
                "text-[0.86em]",
                "rounded-[25%]",
                "text-[length:80cqh]",
                "bg-[Highlight]",
                "fill-[#26251E]",
                "fill-[#EDECEC]",
                "fill-[#0F0F0F]",
                "fill-[#F5F5F5]",
                "fill-[#d97757]",
                "text-[#d97757]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger is a bare button with no styled counterpart
                  // (a disclosure row is not a Button), so its className is the API.
                  // Every other trigger has one: style them with render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
      {
        // Every web file must compile under the React Compiler. Its bailout rules are errors here,
        // and manual memoization is redundant. No upstream rule bans useMemo/useCallback, hence
        // t3code/no-manual-memo.
        files: ["apps/web/src/**/*.{ts,tsx}"],
        rules: {
          "react/exhaustive-effect-dependencies": "error",
          "react/globals": "error",
          "react/hooks": "error",
          "react/immutability": "error",
          // The compiler memoizes context values; this rule would ask for useMemo.
          "react/jsx-no-constructed-context-values": "off",
          "react/memo-dependencies": "error",
          "react/preserve-manual-memoization": "error",
          "react/purity": "error",
          "react/refs": "error",
          "react/set-state-in-effect": "error",
          "react/set-state-in-render": "error",
          "react/static-components": "error",
          "react/unsupported-syntax": "error",
          "t3code/no-manual-memo": "error",
        },
      },
      {
        // The sign-in masthead is T3 brand artwork: fixed gradients, not theme surfaces.
        files: ["apps/web/src/components/auth/AuthSurfaceShell.tsx"],
        rules: { "shadcn/no-arbitrary-values": "off" },
      },
      {
        // The compiler only compiles a use* function that calls a hook; one that calls none is
        // silently left as a plain function, so whatever it returns loses its caching.
        files: ["apps/web/src/**/*.{ts,tsx}"],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "t3code/no-hookless-use-function": "error" },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: false,
      typeCheck: false,
    },
  },
});
