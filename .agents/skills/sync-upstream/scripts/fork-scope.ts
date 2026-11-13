// Upstream paths iglo.code removes outright. Shared by pruning and the filtered import.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Upstream names its own workflows release.yml/ci.yml, so fork names never collide.
export const FORK_WORKFLOWS = new Set(["iglo-release.yml"]);

// Each pattern matches a path or a directory; `*` never crosses `/`.
export const REMOVED_PATHS = [
  // Native mobile app.
  "apps/mobile",
  ".agents/skills/test-t3-mobile",
  "scripts/mobile-*",
  "scripts/export-android-icons.*",
  "scripts/legend-list-initial-reveal.*",
  "docs/internals/mobile-*",
  ".github/scripts/mobile-*",
  "docs/internals/images/mobile-*",
  "docs/operations/mobile-*",
  "apps/web/public/.well-known/apple-app-site-association.json",
  "apps/web/public/.well-known/assetlinks.json",
  "docs/operations/android-notifications.md",
  "docs/user/mobile-notifications.md",
  "oxlint-plugin-t3code/rules/no-mobile-*",
  "oxlint-plugin-t3code/rules/no-hermes-unsupported-apis.*",
  // Desktop app and its packaging.
  "apps/desktop",
  ".devcontainer",
  "docs/internals/devcontainer.md",
  "native/browser-secret",
  "native/hyprland-snap-shot",
  "native/kde-snap-shot",
  ".github/scripts/stage-preview-bundle.*",
  ".github/scripts/vercel-deployment-output.*",
  "scripts/lib/desktop-external-packages.ts",
  "scripts/lib/update-manifest.ts",
  "scripts/lib/windows-jsign.*",
  "scripts/lib/windows-tar.*",
  "scripts/build-desktop-artifact.*",
  "scripts/merge-update-manifests.*",
  "scripts/mock-update-server.*",
  "scripts/sign-macos.*",
  "scripts/verify-windows-desktop-artifact.*",
  "scripts/linux-after-pack.*",
  "scripts/smoke-desktop-app.*",
  "packaging/aur",
  "docs/internals/linux-snap-shot.md",
  "docs/user/snap-shot.md",
  "docs/user/browser-import.md",
  "docs/user/default-browser.md",
  // Check CI, npm publishing, and the Node compile and task caches.
  ".github/actions",
  ".github/scripts/check-nightly-release.*",
  ".github/scripts/mirror-play-apk.*",
  ".github/scripts/relay-state-output.*",
  ".github/scripts/thread-transfer-report.*",
  ".github/scripts/pr-limits.*",
  ".github/scripts/test-delta.*",
  "scripts/build-npm-launcher.*",
  "scripts/npm-launcher",
  "scripts/install.ps1",
  "scripts/prepare-server-compile-cache.*",
  "scripts/lib/server-compile-cache.*",
  "scripts/test-cached.*",
  // Upstream's e2e scenarios drive the mobile simulator as well as the web client.
  "scripts/scenarios",
  "scripts/e2e.config.*",
  "scripts/prove-scenario.*",
  "docs/operations/scenarios.md",
  // Website, hosted services, and upstream's agent setup.
  "apps/marketing",
  "infra/relay",
  "infra/task-cache",
  ".cursor/rules/cursor-cloud.mdc",
];

export const mobileDependency = (name: string) =>
  /^(?:@(?:expo|expo-google-fonts|react-native[^/]*|react-navigation)\/|@clerk\/expo(?:[-@]|$)|expo(?:[-@>]|$)|babel-preset-expo(?:@|$)|react-native(?:[-@>]|$)|uniwind(?:@|$))/.test(
    name,
  );

// Web sign-in still imports @clerk/electron; the server uses @napi-rs/keyring. The Bun
// runtime uses its own PTY; node-pty only served the Node adapter.
export const desktopDependency = (name: string) =>
  /^(?:electron(?:[-@>]|$)|@electron\/asar(?:@|$)|@electron\/osx-sign(?:@|$)|@clerk\/electron-passkeys(?:@|$)|@crowecawcaw\/xa11y(?:@|$)|@electron-webauthn\/|objc-js(?:@|$)|(?:@types\/)?plist(?:@|$)|tldts(?:@|$)|dbus-next(?:[@>]|$)|node-abi(?:[@:]|$)|app-builder-lib(?:@|$)|node-pty(?:[@:]|$))/.test(
    name,
  );

const removedPatch = (fileName: string) => {
  const name = fileName.replaceAll("__", "/").replaceAll("%2F", "/");
  return mobileDependency(name) || desktopDependency(name);
};

const componentPattern = (component: string) =>
  new RegExp(`^${component.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);

const PATTERNS = REMOVED_PATHS.map((pattern) => pattern.split("/").map(componentPattern));

// The fork's tooling is TypeScript on Bun; vendored references keep their own sources.
const isPython = (path: string) => path.endsWith(".py") && !path.startsWith(".repos/");

export const isRemoved = (path: string) => {
  const parts = path.split("/");
  if (parts[0] === ".github" && parts[1] === "workflows" && parts.length > 2) {
    return !FORK_WORKFLOWS.has(parts[2]!);
  }
  if (parts.length === 2 && parts[0] === "patches" && parts[1]!.endsWith(".patch")) {
    return removedPatch(parts[1]!);
  }
  return (
    isPython(path) ||
    PATTERNS.some(
      (wanted) =>
        parts.length >= wanted.length && wanted.every((rx, index) => rx.test(parts[index]!)),
    )
  );
};

const lstat = (path: string) => NodeFS.lstatSync(path, { throwIfNoEntry: false });

/** Expands one REMOVED_PATHS pattern under root without following symlinks. */
const expand = (root: string, pattern: string) => {
  let matches = [""];
  for (const component of pattern.split("/")) {
    const rx = componentPattern(component);
    matches = matches.flatMap((dir) => {
      if (!component.includes("*")) {
        const path = dir ? `${dir}/${component}` : component;
        return lstat(NodePath.join(root, path)) ? [path] : [];
      }
      const stat = lstat(NodePath.join(root, dir));
      if (!stat?.isDirectory()) return [];
      return NodeFS.readdirSync(NodePath.join(root, dir))
        .filter((name) => rx.test(name))
        .toSorted()
        .map((name) => (dir ? `${dir}/${name}` : name));
    });
  }
  return matches;
};

const trackedPython = (root: string) => {
  if (!lstat(NodePath.join(root, ".git"))) return [];
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.py"], { cwd: root });
  return listed.stdout.toString().split("\0").filter(isPython);
};

export const createWorkspace = (root: string) => {
  const changed: string[] = [];
  const remove = (path: string) => {
    const target = NodePath.join(root, path);
    const stat = lstat(target);
    if (!stat) return;
    if (stat.isDirectory()) NodeFS.rmSync(target, { recursive: true });
    else NodeFS.unlinkSync(target);
    changed.push(path);
  };
  const edit = (path: string, transform: (text: string) => string) => {
    const target = NodePath.join(root, path);
    if (!lstat(target)?.isFile()) return;
    const before = NodeFS.readFileSync(target, "utf8");
    const after = transform(before);
    if (after !== before) {
      NodeFS.writeFileSync(target, after);
      changed.push(path);
    }
  };
  return { changed, remove, edit };
};

/** Deletes every removed path present under root. */
export const removeScope = (root: string, remove: (path: string) => void) => {
  if (lstat(NodePath.join(root, ".github/workflows"))?.isSymbolicLink()) {
    remove(".github/workflows");
  }
  for (const pattern of REMOVED_PATHS) for (const path of expand(root, pattern)) remove(path);
  for (const dir of [".github/workflows", "patches"]) {
    if (!lstat(NodePath.join(root, dir))?.isDirectory()) continue;
    for (const name of NodeFS.readdirSync(NodePath.join(root, dir)).toSorted()) {
      if (isRemoved(`${dir}/${name}`)) remove(`${dir}/${name}`);
    }
  }
  for (const path of trackedPython(root)) remove(path);
};

/** JSON edits keep the file untouched unless the parsed value changed. */
export const editJson = (text: string, transform: (data: any) => void) => {
  const data = JSON.parse(text);
  transform(data);
  return JSON.stringify(data) === JSON.stringify(JSON.parse(text))
    ? text
    : `${JSON.stringify(data, null, 2)}\n`;
};

/** End of input, even under the m flag. */
export const END = "(?![\\s\\S])";
