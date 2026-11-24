import { useAtomValue } from "@effect/atom-react";
import type { DesktopUpdateChannel, EnvironmentId } from "@t3tools/contracts";
import { cliReleaseChannelOf, desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";
import { trackReleaseFailureMessage } from "./trackRelease";

interface AppReleaseTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly channel: DesktopUpdateChannel };
}

/** The server that serves this page looks up releases on its own track. Preview builds have none. */
const appReleaseTargetAtom = Atom.make((get): AppReleaseTarget | null => {
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
  const version = newerAppRelease(
    AsyncResult.isSuccess(result) ? result.value.version : null,
    serverVersion,
  );
  const status: AppReleaseStatus =
    target === null
      ? "unavailable"
      : AsyncResult.isInitial(result)
        ? "checking"
        : AsyncResult.isFailure(result)
          ? "error"
          : version !== null
            ? "available"
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

function checkNow<A, E>(queryAtom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  return new Promise<string | null>((resolve) => {
    let started = false;
    let settled = false;
    const finish = (result: AsyncResult.AsyncResult<A, E>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      queueMicrotask(unsubscribe);
      resolve(AsyncResult.isFailure(result) ? trackReleaseFailureMessage(result.cause) : null);
    };
    // A disconnected server leaves the query waiting; report whatever it last answered.
    const timeout = setTimeout(() => finish(appAtomRegistry.get(queryAtom)), CHECK_TIMEOUT_MS);
    const unsubscribe = appAtomRegistry.subscribe(
      queryAtom,
      (result) => {
        if (result.waiting || AsyncResult.isInitial(result)) started = true;
        else if (started) finish(result);
      },
      { immediate: true },
    );
    appAtomRegistry.refresh(queryAtom);
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
