// Reports upstream T3 Code runtime names that would collide with an installed T3 Code,
// and Python files: the fork's tooling is TypeScript on Bun.
// Usage: bun .agents/skills/sync-upstream/scripts/check-fork-identity.ts [--root <checkout>]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

type Rule = { label: string; pattern: RegExp; scope?: readonly string[] };

const DOCS = ["docs/user/", "README.md"];

const RULES: Rule[] = [
  { label: "env var T3CODE_*", pattern: /\bT3CODE_[A-Z0-9_]/g },
  // Environment reads only; T3_* TypeScript constants and unexported shell locals cannot collide.
  {
    label: "env var T3_* read",
    pattern: /(?:process\.env\.|env\.|Config\.\w+\(\s*["'])T3_(?!ACP_)[A-Z0-9_]+/g,
  },
  { label: "~/.t3 or worktree .t3 path", pattern: /(?:^|[^A-Za-z0-9_.-])\.t3(?:\/|["'`]|$)/gm },
  { label: "git ref refs/t3", pattern: /refs\/t3/g },
  { label: "service label", pattern: /com\.t3tools|t3code\.service/g },
  { label: "session cookie", pattern: /\bt3_(?:dev_)?session/g },
  { label: "project file t3.json", pattern: /\bt3\.json\b/g },
  { label: "default port 3773", pattern: /\b3773\b/g },
  { label: "helper/telemetry name", pattern: /t3-resource-monitor|t3code-server|"t3-server"/g },
  {
    label: "MCP server/client name",
    pattern: /mcp__t3[-_]code|["']t3[-_]code["']\s*:|name: ["']t3[-_]code["']/g,
  },
  {
    label: "t3 CLI command",
    pattern:
      /(?:^|[\s`(])t3 (?:serve|up|update|service|doctor|uninstall|pair|start|status|help|install)\b/gm,
    scope: [...DOCS, "AGENTS.md", "apps/server/src/cli/", "scripts/install"],
  },
  { label: "npm install path", pattern: /(?:npx|bunx|npm i(?:nstall)?(?: -g)?) @iglo-tech\//g },
  {
    label: "desktop or mobile app",
    pattern: /desktop app|mobile app|iOS app|Android app/gi,
    scope: DOCS,
  },
  { label: "T3 Connect", pattern: /T3 Connect|app\.t3\.codes/g, scope: DOCS },
  { label: "product name", pattern: /\bT3 Code\b/g, scope: DOCS },
];

// Tests and recording tools use arbitrary ports and their own T3_* knobs; nothing ships them.
const TEST_ONLY_RULES = new Set(["env var T3_* read", "default port 3773"]);
const TEST_PATH =
  /(?:\.test\.|\/test\/|\/testing\/|\/testkit\/|\/testFixtures\/|\/testUtils\/|\/fixtures\/|^apps\/server\/scripts\/|^scripts\/lib\/environment-smoke)/;

const SKIP_PREFIXES = [
  ".repos/",
  ".agents/skills/sync-upstream/",
  "pnpm-lock.yaml",
  "docs/user/open-source-licenses.md",
];

// Reviewed exceptions: [path prefix, rule label, why]. Keep each one justified.
const ALLOW: [string, string, string][] = [
  [
    "apps/server/src/cloud/publicConfig.test.ts",
    "env var T3CODE_*",
    "proves upstream's T3 Connect env vars have no effect on iglo.code",
  ],
  ["README.md", "product name", "attribution: names the upstream project this fork tracks"],
  ["docs/user/faq.md", "product name", "attribution: the FAQ says which project iglo.code forks"],
  [
    "docs/internals/t3-connect.md",
    "env var T3CODE_*",
    "dormant upstream T3 Connect design; names the relay-side secret in upstream's deployment",
  ],
  [
    ".gitignore",
    "~/.t3 or worktree .t3 path",
    "keeps worktree dev state from before the rename out of commits; nothing writes it now",
  ],
  [
    "packages/shared/src/markdownPipeline.test.ts",
    "~/.t3 or worktree .t3 path",
    "a Windows path fixture for backslash rendering; no runtime reads it",
  ],
  [
    "packages/tailscale/src/tailscale.ts",
    "default port 3773",
    "a comment on Go's decimal port parsing (03773); the code compares the configured port",
  ],
];

export type Hit = { path: string; line: number; label: string; text: string };

const trackedFiles = (root: string) =>
  Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })
    .stdout.toString()
    .split("\0")
    .filter(Boolean);

const allowed = (path: string, label: string) =>
  ALLOW.some(([prefix, rule]) => path.startsWith(prefix) && rule === label);

const decoder = new TextDecoder("utf-8", { fatal: true });

export const check = (root: string, files = trackedFiles(root)) => {
  const hits: Hit[] = [];
  for (const path of files) {
    const target = NodePath.join(root, path);
    if (
      path.startsWith(".repos/") ||
      !NodeFS.lstatSync(target, { throwIfNoEntry: false })?.isFile()
    ) {
      continue;
    }
    if (path.endsWith(".py")) {
      hits.push({
        path,
        line: 1,
        label: "Python file",
        text: "port it to TypeScript run with Bun",
      });
      continue;
    }
    if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    let text: string;
    try {
      text = decoder.decode(NodeFS.readFileSync(target));
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (const { label, pattern, scope } of RULES) {
      if (scope && !scope.some((prefix) => path.startsWith(prefix))) continue;
      if (allowed(path, label) || (TEST_ONLY_RULES.has(label) && TEST_PATH.test(path))) continue;
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        hits.push({ path, line, label, text: lines[line - 1]!.trim().slice(0, 140) });
      }
    }
  }
  return hits;
};

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({ options: { root: { type: "string" } } });
  const hits = check(NodePath.resolve(values.root ?? process.cwd()));
  for (const { path, line, label, text } of hits)
    console.log(`${path}:${line}: [${label}] ${text}`);
  if (hits.length > 0) {
    console.error(
      `\n${hits.length} upstream identity hit(s). Rename them per the naming table in sync-upstream's fork-differences.md, or add a justified ALLOW entry.`,
    );
    process.exit(1);
  }
  console.log("No upstream runtime identity found.");
}
