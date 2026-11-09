// Makes a merge-ready upstream commit without the paths iglo.code removes. Its tree is
// upstream's minus fork-scope.ts paths and its parent is the upstream commit, so merging it
// keeps upstream history (and later merge bases) while removed paths never conflict or return.
// Usage: bun .agents/skills/sync-upstream/scripts/filter-upstream.ts [rev=upstream/main]
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { isRemoved } from "./fork-scope.ts";

const git = (
  root: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
};

const nulList = (output: string) => output.split("\0").filter(Boolean);

export const filterCommit = (root: string, rev: string) => {
  const commit = git(root, ["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  const kept: string[] = [];
  let dropped = 0;
  for (const entry of nulList(git(root, ["ls-tree", "-r", "-z", "--full-tree", commit]))) {
    const tab = entry.indexOf("\t");
    const [mode, , oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (isRemoved(path)) dropped += 1;
    else kept.push(`${mode} ${oid}\t${path}`);
  }
  if (dropped === 0) return { commit, dropped };
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "iglo-filter-upstream-"));
  try {
    const env = { GIT_INDEX_FILE: NodePath.join(scratch, "index") };
    git(root, ["update-index", "-z", "--index-info"], { env, input: `${kept.join("\0")}\0` });
    const tree = git(root, ["write-tree"], { env }).trim();
    const message = `Upstream ${commit.slice(0, 10)} without iglo.code's removed paths\n\nDrops ${dropped} files matched by .agents/skills/sync-upstream/scripts/fork-scope.ts.\n`;
    const filtered = git(root, ["commit-tree", tree, "-p", commit], { input: message }).trim();
    return { commit: filtered, dropped };
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
};

/** Upstream edits to files the fork deleted outside fork-scope.ts (modify/delete conflicts). */
export const remainingConflicts = (root: string, rev: string) => {
  const base = git(root, ["merge-base", "HEAD", rev]).trim();
  const changed = nulList(
    git(root, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=M", base, rev]),
  );
  const head = new Set(
    nulList(git(root, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"])),
  );
  return changed.filter((path) => !head.has(path) && !isRemoved(path));
};

if (import.meta.main) {
  const { values, positionals } = NodeUtil.parseArgs({
    options: { root: { type: "string" } },
    allowPositionals: true,
  });
  const root = NodePath.resolve(values.root ?? process.cwd());
  const rev = positionals[0] ?? "upstream/main";
  const { commit, dropped } = filterCommit(root, rev);
  for (const path of remainingConflicts(root, rev)) {
    console.error(`modify/delete outside fork-scope.ts: ${path}`);
  }
  console.error(`Dropped ${dropped} removed-scope files from ${rev}.`);
  console.log(commit);
}
