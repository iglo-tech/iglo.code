#!/usr/bin/env python3
"""Report upstream T3 Code runtime names that would collide with an installed T3 Code."""

import argparse
import re
import subprocess
import sys
from pathlib import Path

# (label, regex, path prefixes it applies to). Empty prefixes means every scanned file.
RULES = [
    ("env var T3CODE_*", r"\bT3CODE_[A-Z0-9_]", ()),
    # Environment reads only; T3_* TypeScript constants and unexported shell locals cannot collide.
    ("env var T3_* read", r"(?:process\.env\.|env\.|Config\.\w+\(\s*[\"'])T3_(?!ACP_)[A-Z0-9_]+", ()),
    ("~/.t3 or worktree .t3 path", r"(?:^|[^A-Za-z0-9_.-])\.t3(?:/|[\"'`]|$)", ()),
    ("git ref refs/t3", r"refs/t3", ()),
    ("service label", r"com\.t3tools|t3code\.service", ()),
    ("session cookie", r"\bt3_(?:dev_)?session", ()),
    ("project file t3.json", r"\bt3\.json\b", ()),
    ("default port 3773", r"\b3773\b", ()),
    ("helper/telemetry name", r"t3-resource-monitor|t3code-server|\"t3-server\"", ()),
    ("MCP server/client name", r"mcp__t3[-_]code|[\"']t3[-_]code[\"']\s*:|name: [\"']t3[-_]code[\"']", ()),
    ("t3 CLI command", r"(?:^|[\s`(])t3 (?:serve|up|update|service|doctor|uninstall|pair|start|status|help|install)\b",
     ("docs/", "README.md", "AGENTS.md", "apps/server/src/cli/", "scripts/install")),
    ("npm install path", r"(?:npx|bunx|npm i(?:nstall)?(?: -g)?) @iglo-tech/", ()),
    ("desktop or mobile app", r"(?i)desktop app|mobile app|iOS app|Android app", ("docs/user/", "README.md")),
    ("T3 Connect", r"T3 Connect|app\.t3\.codes", ("docs/user/", "README.md")),
    ("product name", r"\bT3 Code\b", ("docs/user/", "README.md")),
]

# Tests and recording tools use arbitrary ports and their own T3_* knobs; nothing ships them.
TEST_ONLY_RULES = {"env var T3_* read", "default port 3773"}
TEST_PATH = re.compile(r"(?:\.test\.|/test/|/testing/|/testkit/|/testFixtures/|/testUtils/|/fixtures/|^apps/server/scripts/|^scripts/lib/environment-smoke)")

SKIP_PREFIXES = (".repos/", ".agents/skills/sync-upstream/", "pnpm-lock.yaml", "docs/user/open-source-licenses.md")

# Reviewed exceptions: (path prefix, rule label, why). Keep each one justified.
ALLOW = [
    ("apps/server/src/cloud/publicConfig.test.ts", "env var T3CODE_*",
     "proves upstream's T3 Connect env vars have no effect on iglo.code"),
    ("README.md", "product name", "attribution: names the upstream project this fork tracks"),
    ("docs/user/faq.md", "product name", "attribution: the FAQ says which project iglo.code forks"),
    ("docs/internals/t3-connect.md", "env var T3CODE_*",
     "dormant upstream T3 Connect design; names the relay-side secret in upstream's deployment"),
    (".gitignore", "~/.t3 or worktree .t3 path",
     "keeps worktree dev state from before the rename out of commits; nothing writes it now"),
    ("packages/shared/src/markdownPipeline.test.ts", "~/.t3 or worktree .t3 path",
     "a Windows path fixture for backslash rendering; no runtime reads it"),
    ("packages/tailscale/src/tailscale.ts", "default port 3773",
     "a comment on Go's decimal port parsing (03773); the code compares the configured port"),
]


def tracked_files(root):
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True).stdout
    return [p for p in out.decode().split("\0") if p and not p.startswith(SKIP_PREFIXES)]


def allowed(path, label):
    return any(path.startswith(prefix) and label == rule for prefix, rule, _ in ALLOW)


def check(root, files=None):
    compiled = [(label, re.compile(rx, re.M), scope) for label, rx, scope in RULES]
    hits = []
    for path in files if files is not None else tracked_files(root):
        target = root / path
        if not target.is_file() or target.is_symlink():
            continue
        try:
            text = target.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for label, rx, scope in compiled:
            if scope and not path.startswith(scope):
                continue
            if allowed(path, label) or (label in TEST_ONLY_RULES and TEST_PATH.search(path)):
                continue
            for match in rx.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                hits.append((path, line, label, text.splitlines()[line - 1].strip()[:140]))
    return hits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    hits = check(args.root.resolve())
    for path, line, label, text in hits:
        print(f"{path}:{line}: [{label}] {text}")
    if hits:
        print(f"\n{len(hits)} upstream identity hit(s). Rename them per the sync-upstream naming table, "
              "or add a justified ALLOW entry.", file=sys.stderr)
        return 1
    print("No upstream runtime identity found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
