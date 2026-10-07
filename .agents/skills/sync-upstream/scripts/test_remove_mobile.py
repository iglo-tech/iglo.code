#!/usr/bin/env python3
"""Exercise pruning against a small upstream-shaped checkout."""

import json
import tempfile
import textwrap
import unittest
from pathlib import Path

from remove_mobile import prune


class MobileRemovalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "fork"
        self.root.mkdir()
        self.write("apps/web/package.json", '{"name":"web"}\n')
        self.write("package.json", json.dumps({
            "name": "fork", "scripts": {
                "dev": "node scripts/dev-runner.ts",
                "lint:mobile": "node scripts/mobile-native-static-check.ts",
                "icons:export:android": "node scripts/export-android-icons.ts",
            },
        }))

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(textwrap.dedent(text).lstrip("\n"))

    def test_removes_mobile_and_preserves_shared_and_fork_files(self):
        removed = [
            "apps/mobile/src/entry.ts", ".agents/skills/test-t3-mobile/SKILL.md",
            "scripts/mobile-future-tool.ts", ".github/workflows/mobile-future.yml",
            "patches/@react-native-menu__menu@2.patch", "patches/expo@58.patch",
        ]
        kept = [
            "apps/web/src/entry.ts", "apps/server/src/device/DeviceHubProxy.ts",
            "packages/client-runtime/src/connection/index.ts",
            "patches/effect@4.patch", "patches/@legendapp__list@3.patch",
            ".agents/skills/sync-upstream/SKILL.md", "README.md", "AGENTS.md", ".env",
        ]
        for path in removed + kept:
            self.write(path, "original content\n")
        prune(self.root)
        for path in removed:
            self.assertFalse((self.root / path).exists(), path)
        for path in kept:
            self.assertEqual((self.root / path).read_text(), "original content\n", path)
        self.assertEqual(json.loads((self.root / "package.json").read_text())["scripts"], {
            "dev": "node scripts/dev-runner.ts",
        })
        self.assertEqual(prune(self.root), [])

    def test_prunes_dependency_config_and_obsolete_importers(self):
        self.write("pnpm-workspace.yaml", """
            packages:
              - apps/*
              - packages/*
            catalog:
              "@clerk/expo": 4.6.8
              "@legendapp/list": 3.3.5
              effect: 4.0.0
            overrides:
              expo-router: 58.0.0
              effect: "catalog:"
            packageExtensions:
              "@clerk/expo@*":
                dependencies:
                  "@expo/config-plugins": 58.0.0
              vite-plus@*:
                dependencies:
                  vite: "catalog:"
            patchedDependencies:
              expo@58: patches/expo@58.patch
              effect@4: patches/effect@4.patch
        """)
        self.write("pnpm-lock.yaml", """
            importers:
              .:
                dependencies:
                  effect: {version: 4}
              apps/mobile:
                dependencies:
                  '@clerk/expo': {specifier: 'catalog:', version: 4}
              apps/mobile/modules/terminal:
                dependencies: {}
              apps/web:
                dependencies:
                  effect: {version: 4}
            packages:
              effect@4: {resolution: {integrity: original}}
        """)
        prune(self.root)
        workspace = (self.root / "pnpm-workspace.yaml").read_text()
        self.assertIn("'!apps/mobile'", workspace)
        self.assertIn('effect: "catalog:"', workspace)
        self.assertIn('vite: "catalog:"', workspace)
        self.assertIn('"@legendapp/list": 3.3.5', workspace)
        self.assertNotIn("expo", workspace)
        lock = (self.root / "pnpm-lock.yaml").read_text()
        self.assertNotIn("apps/mobile", lock)
        self.assertIn("apps/web:", lock)
        self.assertIn("integrity: original", lock)
        self.assertEqual(prune(self.root), [])

    def test_removes_ci_jobs_and_native_rules_without_removing_web_rules(self):
        self.write(".github/workflows/ci.yml", """
            jobs:
              test_web:
                name: Test Web
              # The static analysis below needs a macOS runner, which bills more.
              # Keep this comment separate from jobs introduced in future updates.
              mobile_native_changes:
                name: Mobile
              mobile_native_static_analysis:
                needs: mobile_native_changes
              future_shared_job:
                name: Future Shared Job
              release_smoke:
                name: Release Smoke
              check:
                needs:
                  [
                    test_web,
                    mobile_native_changes,
                    mobile_native_static_analysis,
                    release_smoke,
                  ]
        """)
        self.write("vite.config.ts", """
            export default {
              lint: {
                overrides: [
                  {
                    files: ["apps/mobile/src/**"],
                    rules: { "t3code/no-mobile-uniwind-theme-escape-hatches": "error" },
                  },
                  {
                    files: ["apps/web/src/**"],
                    rules: { "web-rule": "error" },
                  },
                ],
              },
            };
        """)
        prune(self.root)
        ci = (self.root / ".github/workflows/ci.yml").read_text()
        self.assertNotIn("mobile_native", ci)
        self.assertIn("release_smoke:", ci)
        self.assertIn("test_web:", ci)
        self.assertIn("future_shared_job:", ci)
        vite = (self.root / "vite.config.ts").read_text()
        self.assertNotIn("apps/mobile", vite)
        self.assertIn('"web-rule": "error"', vite)

    def test_mobile_symlink_is_removed_without_following_it(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        sentinel = outside / "keep.txt"
        sentinel.write_text("keep\n")
        (self.root / "apps/mobile").symlink_to(outside, target_is_directory=True)
        prune(self.root)
        self.assertEqual(sentinel.read_text(), "keep\n")
        self.assertFalse((self.root / "apps/mobile").is_symlink())

    def test_prunes_nested_mobile_paths_and_preserves_shared_rpc_lint_rules(self):
        self.write("vite.config.ts", """
            export default {
              lint: {
                overrides: [
                  {
                    files: ["packages/client-runtime/src/state/**", "apps/{web,mobile,desktop}/src/**"],
                    rules: { "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: false }] },
                  },
                  {
                    // These clients are session metadata, device streams, and an Expo update adapter.
                    files: [
                      "apps/web/src/components/settings/ConnectionsSettings.tsx",
                      "apps/mobile/src/features/updates/app-updates.ts",
                      "apps/web/src/components/device/DevicePhoneViewport.tsx",
                    ],
                    rules: { "t3code/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }] },
                  },
                ],
              },
            };
        """)
        prune(self.root)
        vite = (self.root / "vite.config.ts").read_text()
        self.assertNotIn("apps/mobile", vite)
        self.assertIn('"apps/{web,desktop}/src/**"', vite)
        self.assertNotIn("Expo update adapter", vite)
        self.assertIn("ConnectionsSettings.tsx", vite)
        self.assertIn("DevicePhoneViewport.tsx", vite)
        self.assertIn("allowRawClientAccess: false", vite)
        self.assertIn("allowRawClientAccess: true", vite)
        self.assertEqual(prune(self.root), [])

    def test_license_cleanup_keeps_web_device_notices_and_is_format_independent(self):
        self.write("third-party-licenses.config.json", json.dumps({
            "customNotices": [
                {"name": "native", "bundles": ["mobile"], "noticeFile": "apps/mobile/LICENSE"},
                {"name": "shared", "bundles": ["assets", "mobile", "web"]},
                {"name": "expo-device-hub", "bundles": ["device-tools"], "includeInBundles": ["mobile", "web"]},
            ],
            "packageOverrides": [{"name": "@expo/native"}, {"name": "web-dependency"}],
        }))
        prune(self.root)
        path = self.root / "third-party-licenses.config.json"
        data = json.loads(path.read_text())
        self.assertEqual(data["customNotices"], [
            {"name": "shared", "bundles": ["assets", "web"]},
            {"name": "expo-device-hub", "bundles": ["device-tools"], "includeInBundles": ["web"]},
        ])
        self.assertEqual(data["packageOverrides"], [{"name": "web-dependency"}])
        compact = json.dumps(data, separators=(",", ":")) + "\n"
        path.write_text(compact)
        self.assertEqual(prune(self.root), [])
        self.assertEqual(path.read_text(), compact)

    def test_rejects_a_directory_without_a_web_checkout(self):
        (self.root / "apps/web/package.json").unlink()
        self.write("apps/mobile/keep.txt", "keep\n")
        with self.assertRaises(ValueError):
            prune(self.root)
        self.assertTrue((self.root / "apps/mobile/keep.txt").exists())


if __name__ == "__main__":
    unittest.main()
