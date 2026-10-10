import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeDns from "node:dns";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native dependency resolution runs before an Effect runtime exists.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const Platform = Context.Reference<NodeJS.Platform>("@t3tools/shared/HostProcess/Platform", {
  defaultValue: () => process.platform,
});

export const Architecture = Context.Reference<NodeJS.Architecture>(
  "@t3tools/shared/HostProcess/Architecture",
  {
    defaultValue: () => process.arch,
  },
);

export const Hostname = Context.Reference<string>("@t3tools/shared/HostProcess/Hostname", {
  defaultValue: () => NodeOS.hostname(),
});

export const HomeDirectory = Context.Reference<string>(
  "@t3tools/shared/HostProcess/HomeDirectory",
  {
    defaultValue: () => NodeOS.homedir(),
  },
);

export const Environment = Context.Reference<NodeJS.ProcessEnv>(
  "@t3tools/shared/HostProcess/Environment",
  {
    defaultValue: () => process.env,
  },
);

export const WorkingDirectory = Context.Reference<string>(
  "@t3tools/shared/HostProcess/WorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const ExecutablePath = Context.Reference<string>(
  "@t3tools/shared/HostProcess/ExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const Arguments = Context.Reference<ReadonlyArray<string>>(
  "@t3tools/shared/HostProcess/Arguments",
  {
    defaultValue: () => process.argv,
  },
);

/**
 * The command the shell was given, before the runtime resolved it to the binary:
 * `t3` for a PATH lookup, `./t3` or the launcher symlink for an explicit
 * path. `process.argv[0]` and `execPath` are always the resolved binary.
 */
export const InvokedAs = Context.Reference<string>("@t3tools/shared/HostProcess/InvokedAs", {
  defaultValue: () => process.argv0,
});

/**
 * Bun compiled executables identify the embedded CLI through the virtual
 * `$bunfs` entrypoint. Helpers need a separate interpreter; self-invocations
 * dispatch hidden CLI subcommands directly.
 */
export const IsExecutable = Context.Reference<boolean>("@t3tools/shared/HostProcess/IsExecutable", {
  defaultValue: () => process.argv[1]?.startsWith("/$bunfs/") ?? false,
});

/**
 * Every IP address this machine answers to: the interface addresses, plus
 * whatever the resolver returns for the machine's own hostname. The latter
 * matters because a hostname can map to an address no interface carries —
 * Debian-style hosts put `127.0.1.1` in `/etc/hosts` — and a program that
 * records "its" address by resolving its hostname (Firefox's profile lock
 * does) will write that one. "Is this address ours" has to accept both.
 *
 * Best effort: a failed lookup just leaves the interface set.
 */
export const Addresses = Context.Reference<Effect.Effect<ReadonlySet<string>>>(
  "@t3tools/shared/HostProcess/Addresses",
  {
    defaultValue: () =>
      Effect.gen(function* () {
        const interfaces = Object.values(NodeOS.networkInterfaces())
          .flat()
          .flatMap((entry) => (entry ? [entry.address] : []));
        const resolved = yield* Effect.tryPromise(() =>
          NodeDns.promises.lookup(NodeOS.hostname(), { all: true }),
        ).pipe(
          Effect.map((entries) => entries.map((entry) => entry.address)),
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        );
        return new Set([...interfaces, ...resolved]);
      }),
  },
);

/** Undefined on platforms without POSIX uids (Windows). */
export const UserId = Context.Reference<number | undefined>("@t3tools/shared/HostProcess/UserId", {
  defaultValue: () => process.getuid?.(),
});

export const isWindows = Effect.map(Platform, (platform) => platform === "win32");

/** Resolve disk-backed dependencies beside a compiled CLI, outside Bun's virtual filesystem. */
export const resolveHostModuleUrl = (moduleUrl: string): string =>
  process.argv[1]?.startsWith("/$bunfs/")
    ? NodeURL.pathToFileURL(NodePath.join(NodePath.dirname(process.execPath), "package.json")).href
    : moduleUrl;
