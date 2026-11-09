"""Prune the known upstream desktop integrations and upstream GitHub workflows."""

import json
import re
import shutil

# Upstream names its own workflows release.yml/ci.yml, so fork names never collide.
FORK_WORKFLOWS = {"iglo-release.yml"}


def desktop_dependency(name):
    # Web sign-in still imports @clerk/electron; the server uses @napi-rs/keyring.
    return bool(re.match(
        r"^(?:electron(?:[-@>]|$)|@electron/asar(?:@|$)|@electron/osx-sign(?:@|$)"
        r"|@clerk/electron-passkeys(?:@|$)|@crowecawcaw/xa11y(?:@|$)"
        r"|@electron-webauthn/|objc-js(?:@|$)|(?:@types/)?plist(?:@|$)|tldts(?:@|$)"
        r"|dbus-next(?:[@>]|$)|node-abi(?:[@:]|$)|app-builder-lib(?:@|$)"
        # The Bun runtime uses its own PTY; node-pty only served the Node adapter.
        r"|node-pty(?:[@:]|$))", name
    ))


def dev_runner(text):
    text = re.sub(r"^.*(?:const DESKTOP_DEV_LOOPBACK_HOST|\"dev:desktop\": \[).*\n", "", text, flags=re.M)
    text = text.replace(', "dev:desktop"', "")
    text = re.sub(r"^    const isDesktopMode = .*\n", "", text, flags=re.M)
    text = text.replace('${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}', "localhost")
    start = text.find("    if (!isDesktopMode) {\n")
    end = text.find("    if (!isDesktopMode && host !== undefined)", start)
    if start != -1 and end != -1:
        branch = text[start:end].split("\n    } else {\n", 1)[0]
        branch = branch.removeprefix("    if (!isDesktopMode) {\n")
        branch = re.sub(r"^  ", "", branch, flags=re.M)
        branch = re.sub(r"^    // HOST is Vite.*?^    delete output.HOST;", "    delete output.HOST;", branch, flags=re.M | re.S)
        text = text[:start] + branch + "\n" + text[end:]
    text = text.replace("!isDesktopMode && host", "host")
    text = text.replace("    if (!isDesktopMode) {\n      output.T3CODE_NO_BROWSER = browser === true ? \"0\" : \"1\";\n    }",
                        "    output.T3CODE_NO_BROWSER = browser === true ? \"0\" : \"1\";")
    text = re.sub(r"^    if \(isDesktopMode\) \{\n.*?^    \}\n", "", text, flags=re.M | re.S)
    text = re.sub(r'      \} else if \(input.mode === "dev:desktop"\) \{.*?(?=      \} else \{)', "", text, flags=re.S)
    return text


def prune_desktop(root):
    changed = []

    def remove(path):
        target = root / path
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)
        else:
            return
        changed.append(str(path))

    def edit(path, transform):
        target = root / path
        if target.is_file():
            before = target.read_text()
            after = transform(before)
            if after != before:
                target.write_text(after)
                changed.append(str(path))

    # Checks run locally; the fork's only workflow publishes its own releases.
    workflows = root / ".github/workflows"
    if workflows.is_dir() and not workflows.is_symlink():
        for target in sorted(workflows.iterdir()):
            if target.name not in FORK_WORKFLOWS:
                remove(target.relative_to(root))
    else:
        remove(".github/workflows")
    remove("apps/desktop")
    for path in (
        ".devcontainer", "docs/internals/devcontainer.md",
        "native/browser-secret", "native/hyprland-snap-shot", "native/kde-snap-shot",
        ".github/scripts/stage-preview-bundle.py", ".github/scripts/stage-preview-bundle.test.py",
        "scripts/lib/desktop-external-packages.ts", "scripts/lib/update-manifest.ts",
        "docs/internals/linux-snap-shot.md", "docs/user/snap-shot.md", "docs/user/browser-import.md",
        "docs/user/default-browser.md",
    ):
        remove(path)
    for pattern in ("scripts/build-desktop-artifact.*",
                    "scripts/merge-update-manifests.*", "scripts/mock-update-server.*", "scripts/sign-macos.*",
                    "scripts/verify-windows-desktop-artifact.*", "scripts/lib/windows-jsign.*",
                    "scripts/linux-after-pack.*",
                    "scripts/lib/windows-tar.*", ".github/scripts/vercel-deployment-output.*"):
        for target in sorted(root.glob(pattern)):
            remove(target.relative_to(root))
    for target in sorted((root / "patches").glob("*.patch")):
        if desktop_dependency(target.name.replace("__", "/").replace("%2F", "/")):
            remove(target.relative_to(root))

    def package(text):
        data = json.loads(text)
        data["scripts"] = {
            name: command.replace(" --workspace apps/desktop", "")
            for name, command in data.get("scripts", {}).items()
            if not re.search(r"(?:^|:)desktop(?:$|[:-])", name)
            and not re.search(r"apps/desktop|@t3tools/desktop|scripts/mock-update-server", command.replace(" --workspace apps/desktop", ""))
        }
        if "clean" in data["scripts"]:
            data["scripts"]["clean"] = data["scripts"]["clean"].replace(" apps/*/dist-electron", "")
        return text if data == json.loads(text) else json.dumps(data, indent=2) + "\n"
    edit("package.json", package)

    def workspace(text):
        output = []
        skip_indent = None
        for line in text.splitlines(keepends=True):
            stripped = line.strip()
            indent = len(line) - len(line.lstrip())
            if skip_indent is not None:
                if not stripped or indent > skip_indent:
                    continue
                skip_indent = None
            if re.match(r"\s*-\s+", line):
                name = re.sub(r"^\s*-\s+", "", stripped).strip("\"'")
                if name == "apps/desktop" or desktop_dependency(name):
                    continue
            elif indent == 2 and ":" in stripped and not stripped.startswith("#"):
                name = stripped.split(":", 1)[0].strip("\"'")
                if desktop_dependency(name):
                    skip_indent = indent
                    continue
            if "The dbus-next patch" in line or "registry manifest, so the edge" in line:
                continue
            output.append(line)
        result = "".join(output)
        if not re.search(r"^  - ['\"]!apps/desktop['\"]$", result, re.M):
            result = re.sub(r"(^  - apps/\*\n)", r"\1  - '!apps/desktop'\n", result, count=1, flags=re.M)
        return result
    edit("pnpm-workspace.yaml", workspace)
    edit("pnpm-lock.yaml", lambda text: re.sub(
        r"^  apps/desktop(?:/[^:\n]+)?:\n.*?(?=^  \S|^\S|\Z)", "", text, flags=re.M | re.S,
    ))
    def scripts_package(text):
        data = json.loads(text)
        for field in ("dependencies", "devDependencies"):
            if field in data:
                data[field] = {name: value for name, value in data[field].items()
                               if not desktop_dependency(name)}
        return text if data == json.loads(text) else json.dumps(data, indent=2) + "\n"
    edit("scripts/package.json", scripts_package)
    edit("scripts/build-cli-archive.ts", lambda text: text.replace(
        'from "./build-desktop-artifact.ts"', 'from "./lib/cli-stage.ts"'))
    edit("apps/web/vite.config.ts", lambda text: re.sub(
        r'^.*bundle: "(?:desktop|mobile)".*\n', '', text, flags=re.M,
    ))
    edit("scripts/dev-runner.ts", dev_runner)
    def dev_tests(text):
        text = text.replace("forwards the reusable auth token to web dev and removes it for desktop",
                            "forwards the reusable auth token to web dev")
        text = re.sub(r"^.*(?:const desktop = yield\*|assert.equal\(desktop\.).*\n", "", text, flags=re.M)
        text = re.sub(
            r'^    it\.effect\(.*?(?=^    (?:it\.|//)|^  \}\);|\Z)',
            lambda match: "" if '"dev:desktop"' in match[0] else match[0], text, flags=re.M | re.S,
        )
        return re.sub(r"^(?:    //[^\n]*\n)+",
                      lambda match: "" if re.search(r"desktop|Desktop|Electron", match[0]) else match[0],
                      text, flags=re.M)
    edit("scripts/dev-runner.test.ts", dev_tests)
    edit("scripts/update-release-package-versions.ts", lambda text: text.replace('  "apps/desktop/package.json",\n', ""))
    for path in ("scripts/resolve-nightly-release.ts", "scripts/resolve-nightly-release.test.ts"):
        edit(path, lambda text: text.replace("Desktop", "Server").replace("desktop", "server"))

    def smoke(text):
        text = re.sub(r"^.*apps/desktop.*\n", "", text, flags=re.M)
        text = re.sub(r"^function writeMacManifestFixtures.*?(?=^function assertContains)", "", text, flags=re.M | re.S)
        text = re.sub(r"^function assert(?:Exists|Missing)\(.*?^\}\n\n", "", text, flags=re.M | re.S)
        text = re.sub(r"^  const \{ arm64Path, x64Path \} = writeMacManifestFixtures.*?(?=^  Effect.runSync)", "", text, flags=re.M | re.S)
        return text
    edit("scripts/release-smoke.ts", smoke)
    edit("vite.config.ts", lambda text: re.sub(
        r'^\s*"(?:\*\*/)?dist-electron(?:/\*\*)?",\n', '',
        text.replace("apps/{web,desktop}/src/**", "apps/web/src/**"), flags=re.M,
    ))
    edit("vite.config.ts", lambda text: re.sub(
        r'^      \{\n        files: \["\.devcontainer/devcontainer\.json"\],\n.*?^      \},\n',
        '', text, flags=re.M | re.S,
    ).replace("    overrides: [\n    ],\n", ""))
    edit(".gitignore", lambda text: re.sub(
        r'^(?:dist-electron/|\.electron-runtime/|release-mock/|squashfs-root/)\n', '', text, flags=re.M,
    ))
    edit("knip.jsonc", lambda text: re.sub(
        r'^    "apps/desktop": \{\n.*?^    \},\n', "", text, flags=re.M | re.S,
    ))
    edit(".github/ISSUE_TEMPLATE/bug_report.yml", lambda text: re.sub(
        r"^.*apps/desktop.*\n", "", text, flags=re.M,
    ).replace("OS, browser or desktop app version", "OS and browser version"))

    def licenses(text):
        data = json.loads(text)
        notices = []
        for entry in data.get("customNotices", []):
            if entry.get("noticeFile", "").startswith("apps/desktop/"):
                continue
            for key in ("bundles", "includeInBundles"):
                if key in entry:
                    entry[key] = [bundle for bundle in entry[key] if bundle != "desktop"]
            if entry.get("bundles"):
                notices.append(entry)
        data["customNotices"] = notices
        data["packageOverrides"] = [
            entry for entry in data.get("packageOverrides", [])
            if not desktop_dependency(entry.get("name", ""))
            and not desktop_dependency(entry.get("repositoryUrl", "").rstrip("/").rsplit("/", 1)[-1])
        ]
        return text if data == json.loads(text) else json.dumps(data, indent=2) + "\n"
    edit("third-party-licenses.config.json", licenses)
    edit("docs/README.md", lambda text: text.replace('- [SnapShots](./user/snap-shot.md)\n', '')
         .replace('- [Import browser sessions](./user/browser-import.md)\n', '')
         .replace('- [Use T3 Code as your default browser](./user/default-browser.md)\n', ''))
    edit("docs/operations/development.md", lambda text: text
         .replace('Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.\n\n', '')
         .replace('Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.', 'Use `vp run dev` for server and web.')
         .replace('`apps/server`, `apps/desktop`, `apps/web`', '`apps/server`, `apps/web`')
         .split('## Desktop artifacts')[0].rstrip() + '\n')
    edit(".agents/skills/test-t3-app/SKILL.md", lambda text: text
         .replace("T3 Code's web and desktop UI", "T3 Code's web UI")
         .replace('# Test T3 web and desktop', '# Test T3 web'))
    return changed
