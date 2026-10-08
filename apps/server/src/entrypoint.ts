// @effect-diagnostics nodeBuiltinImport:off
// Entrypoint detection runs before any Effect runtime is built, so it stays on
// Node built-ins.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

/**
 * Whether the module identified by `moduleUrl` is the process entrypoint.
 *
 * Bun answers this through `import.meta.main`. The filesystem comparison
 * also supports a bundled entrypoint reached through a launcher symlink.
 */
export const isEntrypoint = (input: {
  readonly moduleUrl: string;
  readonly entryPath: string | undefined;
  readonly runtimeMain: boolean | undefined;
}): boolean => {
  if (input.runtimeMain !== undefined) {
    return input.runtimeMain;
  }
  if (input.entryPath === undefined || input.entryPath === "") {
    return false;
  }
  if (input.moduleUrl === NodeURL.pathToFileURL(input.entryPath).href) {
    return true;
  }
  // npm and npx install the CLI as a symlink. Without `--preserve-symlinks` the
  // module URL is the resolved real path while `process.argv[1]` keeps the link
  // path, so the comparison above misses.
  try {
    return input.moduleUrl === NodeURL.pathToFileURL(NodeFS.realpathSync(input.entryPath)).href;
  } catch {
    return false;
  }
};
