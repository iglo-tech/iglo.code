import { useAtomValue } from "@effect/atom-react";
import type { DesktopUpdateChannel, EnvironmentId } from "@t3tools/contracts";
import { cliReleaseChannelOf, desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";
import { trackReleaseFailureMessage } from "./trackRelease";

interface AppReleaseTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly channel: DesktopUpdateChannel };
}

/** The server that serves this page looks up releases on its own track. Preview builds have none,
 * and the desktop app has its own updater. */
const appReleaseTargetAtom = Atom.make((get): AppReleaseTarget | null => {
  if (isElectron) return null;
  const environmentId = get(primaryEnvironmentIdAtom);
  const environment = get(serverEnvironment.configValueAtom(environmentId))?.environment;
  if (environmentId === null || environment === undefined) return null;
  if (environment.capabilities.releaseLookup !== true) return null;
  if (cliReleaseChannelOf(environment.serverVersion) === "preview") return null;
  return {
    environmentId,
    input: { channel: desktopUpdateChannelOf(environment.serverVersion) },
  };
}).pipe(Atom.withLabel("web-app-release-target"));

const noReleaseAtom = Atom.make(AsyncResult.initial<never, never>()).pipe(
  Atom.withLabel("web-app-release-none"),
);

/** `latest` when it is newer than both the server and this page, which runs ahead in development. */
export function newerAppRelease(
  latest: string | null,
  serverVersion: string | undefined,
  pageVersion: string = APP_VERSION,
): string | null {
  return latest !== null &&
    serverVersion !== undefined &&
    compareSemverVersions(latest, serverVersion) > 0 &&
    compareSemverVersions(latest, pageVersion) > 0
    ? latest
    : null;
}

export type AppReleaseStatus = "unavailable" | "checking" | "up-to-date" | "available" | "error";

/**
 * The newest release on this server's track. The query re-checks while mounted, which is the
 * automatic check; `check` asks again now.
 */
export function useAppRelease() {
  const target = useAtomValue(appReleaseTargetAtom);
  const serverVersion = useAtomValue(
    serverEnvironment.configValueAtom(target?.environmentId ?? null),
  )?.environment.serverVersion;
  const queryAtom = target === null ? null : serverEnvironment.release(target);
  const result = useAtomValue(queryAtom ?? noReleaseAtom);
  // A failed re-check keeps the last answer, so a known update stays offered.
  const version = newerAppRelease(
    Option.getOrNull(Option.map(AsyncResult.value(result), (release) => release.version)),
    serverVersion,
  );
  const status: AppReleaseStatus =
    target === null
      ? "unavailable"
      : version !== null
        ? "available"
        : AsyncResult.isInitial(result)
          ? "checking"
          : AsyncResult.isFailure(result)
            ? "error"
            : "up-to-date";
  return {
    status,
    version,
    /** A check is running, including the periodic one behind a settled answer. */
    waiting: target !== null && (result.waiting || AsyncResult.isInitial(result)),
    errorMessage: AsyncResult.isFailure(result) ? trackReleaseFailureMessage(result.cause) : null,
    /** Resolves with the check's failure message, or null once it answers. */
    check: (): Promise<string | null> =>
      queryAtom === null ? Promise.resolve(null) : checkNow(queryAtom),
  };
}

const CHECK_TIMEOUT_MS = 60_000;

const isPending = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  result.waiting || AsyncResult.isInitial(result);

/** Refreshes `queryAtom` and resolves with its failure message, or null once it answers. A query
 * that cannot run (its server is not connected) fails within `refresh`, without ever waiting. */
export function checkNow<A, E>(
  queryAtom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  registry: Pick<typeof appAtomRegistry, "get" | "refresh" | "subscribe"> = appAtomRegistry,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    let refreshed = false;
    let settled = false;
    const finish = (message: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      queueMicrotask(unsubscribe);
      resolve(message);
    };
    const settle = (result: AsyncResult.AsyncResult<A, E>) => {
      if (!refreshed || isPending(result)) return;
      finish(AsyncResult.isFailure(result) ? trackReleaseFailureMessage(result.cause) : null);
    };
    const timeout = setTimeout(
      () => finish(m(msg("The server did not answer. Check the connection and try again."))),
      timeoutMs,
    );
    const unsubscribe = registry.subscribe(queryAtom, settle, { immediate: true });
    registry.refresh(queryAtom);
    refreshed = true;
    settle(registry.get(queryAtom));
  });
}

/** The server serving this page already runs a newer build, so this page is stale until it reloads. */
export function usePageBehindServer(): string | null {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverVersion = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .serverVersion;
  return serverVersion !== undefined && compareSemverVersions(serverVersion, APP_VERSION) > 0
    ? serverVersion
    : null;
}
