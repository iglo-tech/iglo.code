#!/usr/bin/env python3
"""Reapply iglo.code's web-only scope without installing dependencies."""

import argparse
import json
import re
import shutil
from pathlib import Path

from remove_desktop import prune_desktop


def mobile_dependency(name):
    return bool(re.match(
        r"^(?:@(?:expo|expo-google-fonts|react-native[^/]*|react-navigation)/"
        r"|@clerk/expo(?:@|$)|expo(?:[-@>]|$)|babel-preset-expo(?:@|$)"
        r"|react-native(?:[-@>]|$)|uniwind(?:@|$))", name
    ))


def prune(root):
    if not (root / "apps/web/package.json").is_file() or not (root / "package.json").is_file():
        raise ValueError("Run in a T3 Code checkout containing apps/web/package.json")
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
        if not target.is_file():
            return
        before = target.read_text()
        after = transform(before)
        if before != after:
            target.write_text(after)
            changed.append(str(path))

    remove("apps/mobile")
    remove(".agents/skills/test-t3-mobile")
    for pattern in (
        "scripts/mobile-*", "scripts/export-android-icons.*",
        "scripts/legend-list-initial-reveal.*", ".github/workflows/mobile-*",
        "docs/internals/mobile-*", "docs/operations/mobile-*",
        "docs/operations/android-notifications.md", "docs/user/mobile-notifications.md",
        "oxlint-plugin-t3code/rules/no-mobile-*",
        "oxlint-plugin-t3code/rules/no-hermes-unsupported-apis.*",
    ):
        for target in sorted(root.glob(pattern)):
            remove(target.relative_to(root))

    # These families only patch the removed native client. Keep web/device patches.
    for target in sorted((root / "patches").glob("*.patch")):
        if mobile_dependency(target.name.replace("__", "/").replace("%2F", "/")):
            remove(target.relative_to(root))

    def package(text):
        data = json.loads(text)
        data["scripts"] = {
            name: command for name, command in data.get("scripts", {}).items()
            if not re.search(r"(?:mobile|android|ios)(?:$|:)", name)
            and not re.search(r"apps/mobile|@t3tools/mobile|scripts/mobile-", command)
        }
        return text if data == json.loads(text) else json.dumps(data, indent=2) + "\n"

    edit("package.json", package)

    def workspace(text):
        lines = text.splitlines(keepends=True)
        output = []
        skip_indent = None
        for line in lines:
            stripped = line.strip()
            indent = len(line) - len(line.lstrip())
            if skip_indent is not None:
                if not stripped or indent > skip_indent:
                    continue
                skip_indent = None
            if re.match(r"\s*-\s+", line):
                name = re.sub(r"^\s*-\s+", "", stripped).strip("\"'")
                if name == "apps/mobile" or mobile_dependency(name):
                    continue
            elif indent == 2 and ":" in stripped and not stripped.startswith("#"):
                name = stripped.split(":", 1)[0].strip("\"'")
                if mobile_dependency(name):
                    skip_indent = indent
                    continue
            if "Earlier React Navigation declarations" in line or "Link http(s) URLs" in line:
                continue
            output.append(line)
        # cn is used only by the removed native client in the current workspace.
        result = "".join(output)
        result = re.sub(r"^  - cn@.*\n", "", result, flags=re.M)
        # Explicit exclusion also covers a copied upstream tree before pruning.
        if "'!apps/mobile'" not in result and '"!apps/mobile"' not in result:
            result = re.sub(r"(^  - apps/\*\n)", r"\1  - '!apps/mobile'\n", result, count=1, flags=re.M)
        return result

    edit("pnpm-workspace.yaml", workspace)

    def lockfile(text):
        # pnpm resolves catalog references in obsolete importers before pruning
        # them. Drop only those importer records; pnpm rebuilds the graph later.
        return re.sub(
            r"^  apps/mobile(?:/[^:\n]+)?:\n.*?(?=^  \S|^\S|\Z)", "",
            text, flags=re.M | re.S,
        )

    edit("pnpm-lock.yaml", lockfile)

    def ci(text):
        # Job keys are two-space mappings. Preserve the surrounding job content.
        text = re.sub(r"^  mobile[\w-]*:.*?(?=^  [\w-]+:|\Z)", "", text, flags=re.M | re.S)
        text = re.sub(r"^        mobile[\w-]*,\n", "", text, flags=re.M)
        text = re.sub(r"^          # Only the macOS lint skips.*\n", "", text, flags=re.M)
        text = re.sub(r'\n            or \(\.key == "mobile_native_static_analysis" and \.value.result == "skipped"\)', "", text)
        text = re.sub(
            r"^  # The static analysis below needs a macOS runner[^\n]*\n(?:  #[^\n]*\n)*",
            "", text, flags=re.M,
        )
        return text

    edit(".github/workflows/ci.yml", ci)

    def vite(text):
        text = re.sub(
            r"^      \{\n.*?^      \},\n",
            lambda match: "" if re.search(r"no-mobile-uniwind|no-hermes-unsupported", match[0]) else match[0],
            text, flags=re.M | re.S,
        )
        text = re.sub(r'^[ \t]+"apps/mobile/[^\n]+\n', "", text, flags=re.M)
        return text.replace("apps/{web,mobile,desktop}/src/**", "apps/{web,desktop}/src/**").replace(
            "session metadata, device streams, and an Expo update adapter.",
            "session metadata and device streams.",
        )

    edit("vite.config.ts", vite)
    edit("oxlint-plugin-t3code/index.ts", lambda text: re.sub(
        r"^.*(?:noMobileUniwindThemeEscapeHatches|noHermesUnsupportedApis).*\n", "", text, flags=re.M,
    ))
    edit("knip.jsonc", lambda text: re.sub(
        r'^    "apps/mobile[^\"]*": \{\n.*?^    \},\n', "",
        text.replace('"mobile-native-client.ts", ', "").replace('"eas", ', "")
        .replace("preprocessor through a CLI option; native verification and\n      // worktree setup", "preprocessor through a CLI option; worktree setup"),
        flags=re.M | re.S,
    ))
    for path in ("scripts/release-smoke.ts", ".github/ISSUE_TEMPLATE/bug_report.yml"):
        edit(path, lambda text: re.sub(r"^.*apps/mobile.*\n", "", text, flags=re.M))
    def license_tests(text):
        text = re.sub(r'^  it\("keeps the GhosttyKit notice.*?^  \}\);\n\n', "", text, flags=re.M | re.S)
        if text.count("REPOSITORY_ROOT") == 1:
            text = re.sub(r"^const REPOSITORY_ROOT = .*?^\);\n", "", text, flags=re.M | re.S)
        if "NodeURL." not in text:
            text = re.sub(r'^import \* as NodeURL from "node:url";\n', "", text, flags=re.M)
        return text

    edit("scripts/lib/third-party-licenses.test.ts", license_tests)

    def licenses(text):
        data = json.loads(text)
        notices = []
        for entry in data.get("customNotices", []):
            if entry.get("noticeFile", "").startswith("apps/mobile/"):
                continue
            for key in ("bundles", "includeInBundles"):
                if key in entry:
                    entry[key] = [bundle for bundle in entry[key] if bundle not in ("mobile", "ios", "android")]
            if entry.get("bundles"):
                notices.append(entry)
        data["customNotices"] = notices
        data["packageOverrides"] = [
            entry for entry in data.get("packageOverrides", [])
            if not mobile_dependency(entry.get("name", ""))
        ]
        return text if data == json.loads(text) else json.dumps(data, indent=2) + "\n"

    edit("third-party-licenses.config.json", licenses)
    edit(".gitignore", lambda text: re.sub(r"^apps/mobile/.*\n", "", text, flags=re.M))
    edit(".cursor/rules/cursor-cloud.mdc", lambda text: re.sub(
        r"^## Android native builds.*?(?=^## |\Z)", "", text, flags=re.M | re.S,
    ))
    edit(".agents/skills/test-t3-app/SKILL.md", lambda text: text
         .replace(" Use test-t3-mobile for native mobile verification.", "")
         .replace(" For native mobile\ntesting, use [test-t3-mobile](../test-t3-mobile/SKILL.md).", ""))
    edit("docs/README.md", lambda text: re.sub(r"^- \[Mobile[^\n]*\n", "", text, flags=re.M))
    edit("docs/operations/development.md", lambda text: text
         .replace("See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.\n", "")
         .replace("Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see", "CI owns the full suite; see"))
    edit("assets/README.md", lambda text: re.sub(
        r"^## Android launcher and splash artwork.*", "", text, flags=re.M | re.S,
    ).rstrip() + "\n")
    return changed + prune_desktop(root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="Checkout to prune (defaults to cwd)")
    args = parser.parse_args()
    changes = prune(args.root.resolve())
    print("\n".join(changes) if changes else "Native app removal already applied; no changes.")
