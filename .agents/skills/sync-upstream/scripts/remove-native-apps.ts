// Reapplies iglo.code's web-only scope without installing dependencies.
// Usage: bun .agents/skills/sync-upstream/scripts/remove-native-apps.ts [--root <checkout>]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { createWorkspace, editJson, END, mobileDependency, removeScope } from "./fork-scope.ts";
import { pruneDesktop } from "./remove-desktop.ts";

const workspace = (text: string) => {
  const output: string[] = [];
  let skipIndent: number | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const stripped = line.trim();
    const indent = line.length - line.trimStart().length;
    if (skipIndent !== undefined) {
      if (!stripped || indent > skipIndent) continue;
      skipIndent = undefined;
    }
    if (/^\s*-\s+/.test(line)) {
      const name = stripped.replace(/^\s*-\s+/, "").replace(/^["']+|["']+$/g, "");
      if (name === "apps/mobile" || mobileDependency(name)) continue;
    } else if (indent === 2 && stripped.includes(":") && !stripped.startsWith("#")) {
      const name = stripped.split(":")[0]!.replace(/^["']+|["']+$/g, "");
      if (mobileDependency(name)) {
        skipIndent = indent;
        continue;
      }
    }
    if (
      line.includes("Earlier React Navigation declarations") ||
      line.includes("Link http(s) URLs")
    ) {
      continue;
    }
    output.push(line);
  }
  // cn is used only by the removed native client in the current workspace.
  const result = output.join("").replace(/^ {2}- cn@.*\n/gm, "");
  // Explicit exclusion also covers a copied upstream tree before pruning.
  return result.includes("'!apps/mobile'") || result.includes('"!apps/mobile"')
    ? result
    : result.replace(/^( {2}- apps\/\*\n)/m, "$1  - '!apps/mobile'\n");
};

const viteConfig = (text: string) =>
  text
    .replace(/^ {6}\{\n.*?^ {6}\},\n/gms, (match) =>
      /no-mobile-uniwind|no-hermes-unsupported|files: \["apps\/mobile\/[^"]*"\]/.test(match)
        ? ""
        : match,
    )
    .replace(/^[ \t]+"apps\/mobile\/[^\n]+\n/gm, "")
    .replaceAll("apps/{web,mobile,desktop}/src/**", "apps/{web,desktop}/src/**")
    .replaceAll(
      "session metadata, device streams, and an Expo update adapter.",
      "session metadata and device streams.",
    );

const licenseTests = (input: string) => {
  let text = input.replace(/^ {2}it\("keeps the GhosttyKit notice.*?^ {2}\}\);\n\n/gms, "");
  if (text.split("REPOSITORY_ROOT").length === 2) {
    text = text.replace(/^const REPOSITORY_ROOT = .*?^\);\n/gms, "");
  }
  return text.includes("NodeURL.")
    ? text
    : text.replace(/^import \* as NodeURL from "node:url";\n/gm, "");
};

type Notice = { noticeFile?: string; bundles?: string[]; includeInBundles?: string[] };

const licenses = (text: string) =>
  editJson(text, (data) => {
    if (Array.isArray(data.customNotices)) {
      data.customNotices = (data.customNotices as Notice[]).flatMap((entry) => {
        if (entry.noticeFile?.startsWith("apps/mobile/")) return [];
        for (const key of ["bundles", "includeInBundles"] as const) {
          const bundles = entry[key];
          if (bundles) {
            entry[key] = bundles.filter((bundle) => !["mobile", "ios", "android"].includes(bundle));
          }
        }
        return entry.bundles?.length ? [entry] : [];
      });
    }
    if (Array.isArray(data.packageOverrides)) {
      data.packageOverrides = (data.packageOverrides as { name?: string }[]).filter(
        (entry) => !mobileDependency(entry.name ?? ""),
      );
    }
  });

// A comment block whose every path is in apps/mobile goes with those paths.
const macroscopeIgnore = (text: string) => {
  const blocks: string[] = [];
  for (const block of text.split(/\n(?=\n)/)) {
    const lines = block.split("\n");
    const kept = lines.filter(
      (line) => !line.includes("apps/mobile") || line.trimStart().startsWith("#"),
    );
    const patterns = kept.filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    if (kept.length !== lines.length && patterns.length === 0) continue;
    blocks.push(kept.join("\n"));
  }
  const result = blocks.join("\n");
  return text.endsWith("\n") ? `${result.replace(/\n+$/, "")}\n` : result;
};

export const prune = (root: string) => {
  if (
    !NodeFS.existsSync(NodePath.join(root, "apps/web/package.json")) ||
    !NodeFS.existsSync(NodePath.join(root, "package.json"))
  ) {
    throw new Error("Run in a T3 Code checkout containing apps/web/package.json");
  }
  const { changed, remove, edit } = createWorkspace(root);
  removeScope(root, remove);

  // The fork ships no website; its scripts go with the native app scripts.
  edit("package.json", (text) =>
    editJson(text, (data) => {
      if (!data.scripts) return;
      data.scripts = Object.fromEntries(
        Object.entries(data.scripts as Record<string, string>).filter(
          ([name, command]) =>
            !/(?:mobile|android|ios|marketing)(?:$|:)/.test(name) &&
            !/apps\/(?:mobile|marketing)|@t3tools\/(?:mobile|marketing)|scripts\/mobile-/.test(
              command,
            ),
        ),
      );
    }),
  );
  edit("pnpm-workspace.yaml", workspace);
  // pnpm resolves catalog references in obsolete importers before pruning them. Drop only
  // those importer records; pnpm rebuilds the graph later.
  edit("pnpm-lock.yaml", (text) =>
    text.replace(
      new RegExp(
        `^ {2}apps/(?:mobile(?:/[^:\\n]+)?|marketing):\\n.*?(?=^ {2}\\S|^\\S|${END})`,
        "gms",
      ),
      "",
    ),
  );
  edit("vite.config.ts", viteConfig);
  edit("oxlint-plugin-t3code/index.ts", (text) =>
    text.replace(/^.*(?:noMobileUniwindThemeEscapeHatches|noHermesUnsupportedApis).*\n/gm, ""),
  );
  edit("knip.jsonc", (text) =>
    text
      .replaceAll('"mobile-native-client.ts", ', "")
      .replaceAll('"eas", ', "")
      .replaceAll(
        "preprocessor through a CLI option; native verification and\n      // worktree setup",
        "preprocessor through a CLI option; worktree setup",
      )
      .replace(/^ {4}"apps\/(?:mobile[^"]*|marketing)": \{\n.*?^ {4}\},\n/gms, ""),
  );
  edit("scripts/release-smoke.ts", (text) =>
    // Remove the complete copy block before dropping its path declaration.
    text
      .replace(/^ {2}if \(NodeFS\.existsSync\(mobileDependencies\)\) \{\n.*?^ {2}\}\n\n/gms, "")
      .replace(/^.*apps\/(?:mobile|marketing\/).*\n/gm, ""),
  );
  edit(".github/ISSUE_TEMPLATE/bug_report.yml", (text) =>
    text.replace(/^.*apps\/mobile.*\n/gm, ""),
  );
  edit("scripts/lib/third-party-licenses.test.ts", licenseTests);
  edit("third-party-licenses.config.json", licenses);
  edit("scripts/effect-budget.json", (text) =>
    editJson(text, (data) => {
      for (const path of Object.keys(data)) {
        if (path.startsWith("apps/mobile/") || path.startsWith("apps/desktop/")) delete data[path];
      }
    }),
  );
  edit(".gitignore", (text) =>
    text.replace(/^(?:apps\/mobile\/.*|\.astro|apps\/marketing\/.*)\n/gm, ""),
  );
  edit(".macroscope/ignore.md", macroscopeIgnore);
  edit(".agents/skills/test-t3-app/SKILL.md", (text) =>
    text
      .replaceAll(" Use test-t3-mobile for native mobile verification.", "")
      .replaceAll(
        " For native mobile\ntesting, use [test-t3-mobile](../test-t3-mobile/SKILL.md).",
        "",
      ),
  );
  edit("docs/README.md", (text) => text.replace(/^- \[Mobile[^\n]*\n/gm, ""));
  edit("docs/operations/development.md", (text) =>
    text
      .replaceAll(
        "See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.\n",
        "",
      )
      .replaceAll(
        "Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see",
        "CI owns the full suite; see",
      ),
  );
  edit(
    "assets/README.md",
    (text) => `${text.replace(/^## Android launcher and splash artwork.*/ms, "").trimEnd()}\n`,
  );
  // A comment directly above a marketing path describes only that entry.
  edit("vite.config.ts", (text) =>
    text.replace(/(?:^[ \t]+\/\/[^\n]*\n)?^[ \t]+"apps\/marketing\/[^\n]*\n/gm, ""),
  );
  return [...changed, ...pruneDesktop(root)];
};

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({ options: { root: { type: "string" } } });
  const changes = prune(NodePath.resolve(values.root ?? process.cwd()));
  console.log(
    changes.length > 0 ? changes.join("\n") : "Native app removal already applied; no changes.",
  );
}
