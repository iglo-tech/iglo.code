// Rewrites the known upstream desktop integrations in shared files.
import { createWorkspace, desktopDependency, editJson, END } from "./fork-scope.ts";

const DEV_RUNNER_DESKTOP_BRANCH = "    if (!isDesktopMode && host !== undefined)";

const devRunner = (input: string) => {
  let text = input
    .replace(/^.*(?:const DESKTOP_DEV_LOOPBACK_HOST|"dev:desktop": \[).*\n/gm, "")
    .replaceAll(', "dev:desktop"', "")
    .replace(/^ {4}const isDesktopMode = .*\n/gm, "")
    .replaceAll('${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}', "localhost");
  const start = text.indexOf("    if (!isDesktopMode) {\n");
  const end = start === -1 ? -1 : text.indexOf(DEV_RUNNER_DESKTOP_BRANCH, start);
  if (start !== -1 && end !== -1) {
    const branch = text
      .slice(start, end)
      .split("\n    } else {\n")[0]!
      .slice("    if (!isDesktopMode) {\n".length)
      .replace(/^ {2}/gm, "")
      .replace(/^ {4}\/\/ HOST is Vite.*?^ {4}delete output.HOST;/gms, "    delete output.HOST;");
    text = `${text.slice(0, start)}${branch}\n${text.slice(end)}`;
  }
  return text
    .replaceAll("!isDesktopMode && host", "host")
    .replaceAll(
      '    if (!isDesktopMode) {\n      output.T3CODE_NO_BROWSER = browser === true ? "0" : "1";\n    }',
      '    output.T3CODE_NO_BROWSER = browser === true ? "0" : "1";',
    )
    .replace(/^ {4}if \(isDesktopMode\) \{\n.*?^ {4}\}\n/gms, "")
    .replace(/ {6}\} else if \(input.mode === "dev:desktop"\) \{.*?(?= {6}\} else \{)/gs, "");
};

const devRunnerTests = (text: string) =>
  text
    .replaceAll(
      "forwards the reusable auth token to web dev and removes it for desktop",
      "forwards the reusable auth token to web dev",
    )
    .replace(/^.*(?:const desktop = yield\*|assert.equal\(desktop\.).*\n/gm, "")
    .replace(
      new RegExp(`^ {4}it\\.effect\\(.*?(?=^ {4}(?:it\\.|//)|^ {2}\\}\\);|${END})`, "gms"),
      (match) => (match.includes('"dev:desktop"') ? "" : match),
    )
    .replace(/^(?: {4}\/\/[^\n]*\n)+/gm, (match) =>
      /desktop|Desktop|Electron/.test(match) ? "" : match,
    );

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
      if (name === "apps/desktop" || desktopDependency(name)) continue;
    } else if (indent === 2 && stripped.includes(":") && !stripped.startsWith("#")) {
      const name = stripped.split(":")[0]!.replace(/^["']+|["']+$/g, "");
      if (desktopDependency(name)) {
        skipIndent = indent;
        continue;
      }
    }
    if (line.includes("The dbus-next patch") || line.includes("registry manifest, so the edge")) {
      continue;
    }
    output.push(line);
  }
  const result = output.join("");
  return /^ {2}- ['"]!apps\/desktop['"]$/m.test(result)
    ? result
    : result.replace(/^( {2}- apps\/\*\n)/m, "$1  - '!apps/desktop'\n");
};

const releaseSmoke = (text: string) =>
  text
    .replace(/^.*apps\/desktop.*\n/gm, "")
    .replace(/^function writeMacManifestFixtures.*?(?=^function assertContains)/gms, "")
    .replace(/^function assert(?:Exists|Missing)\(.*?^\}\n\n/gms, "")
    .replace(
      /^ {2}const \{ arm64Path, x64Path \} = writeMacManifestFixtures.*?(?=^ {2}Effect.runSync)/gms,
      "",
    );

type Notice = { noticeFile?: string; bundles?: string[]; includeInBundles?: string[] };
type Override = { name?: string; repositoryUrl?: string };

const licenses = (text: string) =>
  editJson(text, (data) => {
    if (Array.isArray(data.customNotices)) {
      data.customNotices = (data.customNotices as Notice[]).flatMap((entry) => {
        if (entry.noticeFile?.startsWith("apps/desktop/")) return [];
        for (const key of ["bundles", "includeInBundles"] as const) {
          const bundles = entry[key];
          if (bundles) entry[key] = bundles.filter((bundle) => bundle !== "desktop");
        }
        return entry.bundles?.length ? [entry] : [];
      });
    }
    if (Array.isArray(data.packageOverrides)) {
      data.packageOverrides = (data.packageOverrides as Override[]).filter(
        (entry) =>
          !desktopDependency(entry.name ?? "") &&
          !desktopDependency((entry.repositoryUrl ?? "").replace(/\/+$/, "").split("/").at(-1)!),
      );
    }
  });

export const pruneDesktop = (root: string) => {
  const { changed, edit } = createWorkspace(root);
  edit("package.json", (text) =>
    editJson(text, (data) => {
      if (!data.scripts) return;
      data.scripts = Object.fromEntries(
        Object.entries(data.scripts as Record<string, string>)
          .map(([name, command]) => [name, command.replaceAll(" --workspace apps/desktop", "")])
          .filter(
            ([name, command]) =>
              !/(?:^|:)desktop(?:$|[:-])/.test(name!) &&
              !/apps\/desktop|@t3tools\/desktop|scripts\/mock-update-server/.test(command!),
          ),
      );
      if (data.scripts.clean) {
        data.scripts.clean = data.scripts.clean.replaceAll(" apps/*/dist-electron", "");
      }
    }),
  );
  edit("pnpm-workspace.yaml", workspace);
  edit("pnpm-lock.yaml", (text) =>
    text.replace(
      new RegExp(`^ {2}apps/desktop(?:/[^:\\n]+)?:\\n.*?(?=^ {2}\\S|^\\S|${END})`, "gms"),
      "",
    ),
  );
  edit("scripts/package.json", (text) =>
    editJson(text, (data) => {
      for (const field of ["dependencies", "devDependencies"]) {
        if (!data[field]) continue;
        data[field] = Object.fromEntries(
          Object.entries(data[field]).filter(([name]) => !desktopDependency(name)),
        );
      }
    }),
  );
  edit("scripts/build-cli-archive.ts", (text) =>
    text.replaceAll('from "./build-desktop-artifact.ts"', 'from "./lib/cli-stage.ts"'),
  );
  edit("apps/web/vite.config.ts", (text) =>
    text.replace(/^.*bundle: "(?:desktop|mobile)".*\n/gm, ""),
  );
  edit("scripts/dev-runner.ts", devRunner);
  edit("scripts/dev-runner.test.ts", devRunnerTests);
  edit("scripts/update-release-package-versions.ts", (text) =>
    text.replaceAll('  "apps/desktop/package.json",\n', ""),
  );
  for (const path of [
    "scripts/resolve-nightly-release.ts",
    "scripts/resolve-nightly-release.test.ts",
  ]) {
    edit(path, (text) => text.replaceAll("Desktop", "Server").replaceAll("desktop", "server"));
  }
  edit("scripts/release-smoke.ts", releaseSmoke);
  edit("vite.config.ts", (text) =>
    text
      .replaceAll("apps/{web,desktop}/src/**", "apps/web/src/**")
      .replace(/^\s*"(?:\*\*\/)?dist-electron(?:\/\*\*)?",\n/gm, ""),
  );
  edit("vite.config.ts", (text) =>
    text
      .replace(
        /^ {6}\{\n {8}files: \["\.devcontainer\/devcontainer\.json"\],\n.*?^ {6}\},\n/gms,
        "",
      )
      .replaceAll("    overrides: [\n    ],\n", ""),
  );
  edit(".gitignore", (text) =>
    text.replace(
      /^(?:dist-electron\/|\.electron-runtime\/|release-mock\/|squashfs-root\/)\n/gm,
      "",
    ),
  );
  edit("knip.jsonc", (text) => text.replace(/^ {4}"apps\/desktop": \{\n.*?^ {4}\},\n/gms, ""));
  edit(".github/ISSUE_TEMPLATE/bug_report.yml", (text) =>
    text
      .replace(/^.*apps\/desktop.*\n/gm, "")
      .replaceAll("OS, browser or desktop app version", "OS and browser version"),
  );
  edit("third-party-licenses.config.json", licenses);
  edit("docs/README.md", (text) =>
    text
      .replaceAll("- [SnapShots](./user/snap-shot.md)\n", "")
      .replaceAll("- [Import browser sessions](./user/browser-import.md)\n", "")
      .replaceAll("- [Use T3 Code as your default browser](./user/default-browser.md)\n", ""),
  );
  edit(
    "docs/operations/development.md",
    (text) =>
      `${text
        .replaceAll(
          "Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.\n\n",
          "",
        )
        .replaceAll(
          "Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.",
          "Use `vp run dev` for server and web.",
        )
        .replaceAll("`apps/server`, `apps/desktop`, `apps/web`", "`apps/server`, `apps/web`")
        .split("## Desktop artifacts")[0]!
        .trimEnd()}\n`,
  );
  edit(".agents/skills/test-t3-app/SKILL.md", (text) =>
    text
      .replaceAll("T3 Code's web and desktop UI", "T3 Code's web UI")
      .replaceAll("# Test T3 web and desktop", "# Test T3 web"),
  );
  return changed;
};
