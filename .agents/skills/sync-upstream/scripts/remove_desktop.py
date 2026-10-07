"""Prune the known upstream desktop integrations while preserving CLI releases."""

import json
import re
import shutil


def desktop_dependency(name):
    # Web sign-in still imports @clerk/electron; the server uses @napi-rs/keyring.
    return bool(re.match(
        r"^(?:electron(?:[-@>]|$)|@electron/asar(?:@|$)|@electron/osx-sign(?:@|$)"
        r"|@clerk/electron-passkeys(?:@|$)|@crowecawcaw/xa11y(?:@|$)"
        r"|dbus-next(?:[@>]|$)|node-abi(?:[@:]|$))", name
    ))


def workflow_steps(text, transform):
    return re.sub(
        r"^      - .*?(?=^      - |^  [\w-]+:|\Z)",
        lambda match: transform(match[0]), text, flags=re.M | re.S,
    )


def remove_steps(text, names):
    return workflow_steps(text, lambda step: "" if any(
        re.search(r"^      - name: " + re.escape(name) + r"\s*$", step, re.M)
        for name in names
    ) else step)


def strip_native_comments(text):
    # Drop whole comment paragraphs rather than leaving fragments of removed guidance.
    return re.sub(
        r"^(?:[ \t]*#[^\n]*\n)+",
        lambda match: "" if re.search(
            r"desktop|Desktop|Electron|electron|browser secret|browser-secret|capture helpers|WSL",
            match[0],
        ) else match[0], text, flags=re.M,
    )


def cli_workflow(text):
    text = remove_steps(text, {
        "Cache Linux capture helpers", "Install Linux desktop build libraries",
        "Wait for Linux CLI archive", "Download Linux CLI archive for WSL",
        "Build desktop artifact", "Collect release assets", "Upload build artifacts",
    })
    text = strip_native_comments(text)
    text = text.replace("name: Release desktop build", "name: Release CLI build")
    text = text.replace("Install desktop dependencies", "Install CLI dependencies")
    text = text.replace("--filter=@t3tools/desktop... ", "")
    for key in ("MACOS_PROVISIONING_PROFILE", "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
                "target", "cli_archive", "release_channel"):
        text = re.sub(r"^      " + key + r":\n(?:        [^\n]*\n)+", "", text, flags=re.M)
    text = re.sub(r"^          AZURE_TRUSTED_SIGNING_PUBLISHER_NAME:.*\n", "", text, flags=re.M)
    text = re.sub(r"^            \$env:AZURE_TRUSTED_SIGNING_PUBLISHER_NAME\n", "", text, flags=re.M)
    text = text.replace("$env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,",
                        "$env:AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME")
    text = re.sub(r"^    timeout-minutes:.*\n", "    timeout-minutes: 30\n", text, flags=re.M)
    text = re.sub(r"^        if: inputs.cli_archive\s*\n", "", text, flags=re.M)
    text = text.replace("inputs.cli_archive && ", "")
    text = re.sub(r"^        if: steps.resource_monitor_cache.outputs.cache-hit.*\n",
                  "        if: steps.resource_monitor_cache.outputs.cache-hit != 'true'\n", text, flags=re.M)
    text = text.replace("          path: apps\n", "          path: apps/server/dist\n")
    build_monitor = """      - name: Build resource monitor
        if: steps.resource_monitor_cache.outputs.cache-hit != 'true'
        shell: bash
        run: cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target "${{ inputs.rust_target }}"

"""
    text = text.replace("      - name: Stage resource monitor for the CLI archive\n",
                        build_monitor + "      - name: Stage resource monitor for the CLI archive\n")
    return text


def release_workflow(text):
    text = re.sub(r"^  desktop_mac_x64:.*?(?=^  [\w-]+:|\Z)", "", text, flags=re.M | re.S)
    text = re.sub(r"^  publish_aur:.*?(?=^  [\w-]+:|\Z)", "", text, flags=re.M | re.S)
    text = remove_steps(text, {
        "Ensure Electron runtime is installed",
        "Download all desktop artifacts", "Refuse updater metadata on preview releases",
        "Merge macOS updater manifests", "Merge Windows updater manifests",
    })
    text = workflow_steps(text, lambda step: (
        step.replace("Install browser secret helper build libraries", "Install C toolchain for process-tree fixtures")
        .replace("libsecret-1-dev pkg-config ", "") if "build-essential" in step else ""
    ) if "name: Install browser secret helper build libraries" in step else step)
    text = strip_native_comments(text)
    text = re.sub(r"^        desktop_mac_x64,\n", "", text, flags=re.M)
    text = text.replace(" && needs.desktop_mac_x64.result == 'success'", "")
    text = text.replace("desktop_", "cli_").replace("name: Desktop ", "name: CLI ")
    text = text.replace("release-desktop.yml", "release-cli.yml")
    text = re.sub(r"^  cli_[\w-]+:.*?(?=^  [\w-]+:|\Z)", lambda match: re.sub(
        r"^      (?:target|cli_archive|release_channel):.*\n", "", match[0], flags=re.M,
    ), text, flags=re.M | re.S)
    text = text.replace(" --filter=@t3tools/desktop...", "")
    text = text.replace("vp run build:desktop", "vp run --filter t3 build")
    text = re.sub(r"^            apps/desktop/dist-electron\n", "", text, flags=re.M)
    text = text.replace(" apps/desktop/package.json", "")
    text = text.replace(
        "      # Two paths under apps/ so the artifact root is apps/; consumers download\n"
        "      # into `apps` to restore both at their original locations.\n",
        "      # The artifact contains the dist directory's contents; consumers restore it there.\n",
    )
    text = workflow_steps(text, lambda step: re.sub(
        r"^[ \t]+echo 'release-assets/\*\.(?:dmg|AppImage|deb|exe|blockmap|yml)'\n", "", step, flags=re.M,
    ).replace(
        '            if [[ "${{ needs.preflight.outputs.release_channel }}" != "preview" ]]; then\n            fi\n', "",
    ) if "name: Resolve release asset list" in step else step)
    return text


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

    desktop_release = root / ".github/workflows/release-desktop.yml"
    if desktop_release.is_file():
        cli_release = root / ".github/workflows/release-cli.yml"
        cli_release.write_text(cli_workflow(desktop_release.read_text()))
        changed.append(str(cli_release.relative_to(root)))
    remove("apps/desktop")
    for path in (
        "native/browser-secret", "native/hyprland-snap-shot", "native/kde-snap-shot",
        ".github/workflows/release-desktop.yml", ".github/workflows/publish-aur.yml",
        ".github/scripts/stage-preview-bundle.py", ".github/scripts/stage-preview-bundle.test.py",
        "scripts/lib/desktop-external-packages.ts", "scripts/lib/update-manifest.ts",
        "docs/internals/linux-snap-shot.md", "docs/user/snap-shot.md", "docs/user/browser-import.md",
    ):
        remove(path)
    for pattern in (".github/workflows/desktop-*", "scripts/build-desktop-artifact.*",
                    "scripts/merge-update-manifests.*", "scripts/mock-update-server.*", "scripts/sign-macos.*"):
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
    for path in (".github/workflows/ci.yml", ".github/workflows/windows-tests.yml"):
        edit(path, lambda text: strip_native_comments(remove_steps(text, {
            "Ensure Electron runtime is installed", "Start installing browser secret helper build libraries",
            "Finish installing browser secret helper build libraries", "Verify preload bundle output",
            "Test preview artifact validation",
        })).replace("Build desktop pipeline", "Build web and server")
             .replace("vp run build:desktop", "vp run --filter t3 build")
             .replace("resource-monitor kde-snap-shot hyprland-snap-shot", "resource-monitor"))
    edit(".github/workflows/release.yml", release_workflow)
    edit(".devcontainer/update-content.sh", lambda text: strip_native_comments(
        re.sub(r"^.*@t3tools/desktop.*\n", "", text, flags=re.M)))

    def scripts_package(text):
        data = json.loads(text)
        data["dependencies"] = {name: value for name, value in data.get("dependencies", {}).items()
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
        data["packageOverrides"] = [entry for entry in data.get("packageOverrides", [])
                                    if not desktop_dependency(entry.get("name", ""))]
        return text if data == json.loads(text) else json.dumps(data, indent=2) + "\n"
    edit("third-party-licenses.config.json", licenses)
    edit("docs/README.md", lambda text: text.replace('- [SnapShots](./user/snap-shot.md)\n', '')
         .replace('- [Import browser sessions](./user/browser-import.md)\n', ''))
    edit("docs/operations/development.md", lambda text: text
         .replace('Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.', 'Use `vp run dev` for server and web.')
         .replace('`apps/server`, `apps/desktop`, `apps/web`', '`apps/server`, `apps/web`')
         .split('## Desktop artifacts')[0].rstrip() + '\n')
    edit(".agents/skills/test-t3-app/SKILL.md", lambda text: text
         .replace("T3 Code's web and desktop UI", "T3 Code's web UI")
         .replace('# Test T3 web and desktop', '# Test T3 web'))
    return changed
