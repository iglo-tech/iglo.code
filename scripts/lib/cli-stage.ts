type BuildPlatform = "mac" | "linux" | "win";
type BuildArch = "arm64" | "x64";

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;

/** Select the file finder binaries for the archive's platform and architecture. */
export function resolveFffNativeDependencies(
  platform: BuildPlatform,
  arch: BuildArch,
  version: string,
): Record<string, string> {
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const suffixes = platform === "linux" ? [`${arch}-gnu`, `${arch}-musl`] : [arch];
  return Object.fromEntries(
    suffixes.map((suffix) => [`@ff-labs/fff-bin-${hostOs}-${suffix}`, version]),
  );
}

/** Keep pnpm's optional native dependencies aligned with the archive's target. */
export function createStageWorkspaceConfig(input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}) {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return {
    supportedArchitectures: {
      os: [hostOs],
      cpu: [arch],
      ...(platform === "linux" ? { libc: ["glibc"] } : {}),
    },
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

/** Stage only patches for dependency roots carried by the archive. */
export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) => {
      const versionSeparator = patchKey.lastIndexOf("@");
      const name = versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
      return Object.hasOwn(dependencies, name);
    }),
  );
}
