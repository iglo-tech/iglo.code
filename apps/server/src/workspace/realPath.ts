// @effect-diagnostics nodeBuiltinImport:off - Bun realpath workaround over the same native calls WorkspaceFileSystem uses.
import * as NodeFSP from "node:fs/promises";

// Bun 1.4.3's `fs.realpath` collapses `link/..` before following the link and
// fails with ENOENT on any path containing a backslash, a valid POSIX name
// character. Its lstat and readlink are correct, so POSIX absolute paths
// resolve one segment at a time with Node's semantics. Node keeps the native call.
const walkPosixPaths = process.versions.bun !== undefined;

const MAX_SYMLINKS = 40;

const segmentsOf = (path: string) =>
  path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .toReversed();

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const walkRealPath = async (path: string): Promise<string> => {
  const pending = segmentsOf(path);
  let resolved = "/";
  let links = 0;
  while (pending.length > 0) {
    const segment = pending.pop()!;
    if (segment === "..") {
      resolved = parentOf(resolved);
      continue;
    }
    const next = resolved === "/" ? `/${segment}` : `${resolved}/${segment}`;
    if (!(await NodeFSP.lstat(next)).isSymbolicLink()) {
      resolved = next;
      continue;
    }
    if (++links > MAX_SYMLINKS) {
      throw Object.assign(new Error(`ELOOP: too many symbolic links, realpath '${path}'`), {
        code: "ELOOP",
        path,
      });
    }
    const target = await NodeFSP.readlink(next);
    if (target.startsWith("/")) resolved = "/";
    pending.push(...segmentsOf(target));
  }
  return resolved;
};

export const realPath = (path: string): Promise<string> =>
  walkPosixPaths && path.startsWith("/") ? walkRealPath(path) : NodeFSP.realpath(path);
