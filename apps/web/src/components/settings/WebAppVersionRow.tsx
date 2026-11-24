import { useAtomValue } from "@effect/atom-react";
import { managedUpdatesDenial } from "@t3tools/client-runtime/contract-labels";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { APP_VERSION } from "~/branding";
import { useAppRelease, usePageBehindServer } from "~/state/appRelease";
import { useEnvironments } from "~/state/environments";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { serverEnvironment } from "~/state/server";
import { resolveServerSelfUpdateCapability } from "~/versionSkew";
import { useCheckProviderUpdates } from "../ProviderUpdatesAction";
import { ServerUpdateAction } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AboutVersionTitle } from "./AboutVersionTitle";
import { SettingsRow } from "./settingsLayout";

/** Without the desktop app, the server serving this page is the app: it checks and updates itself. */
export function WebAppVersionRow({ id }: { readonly id: string }) {
  const gt = useGT();
  const messages = useMessages();
  const updatesDenial = managedUpdatesDenial(usePrimaryManagedPolicy(), messages);
  const release = useAppRelease();
  const pageBehindVersion = usePageBehindServer();
  const checkProviderUpdates = useCheckProviderUpdates();
  const [isChecking, setIsChecking] = useState(false);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(primaryEnvironmentId));
  const serverLabel =
    useEnvironments().environments.find(
      (environment) => environment.environmentId === primaryEnvironmentId,
    )?.label ?? gt("This server");

  const check = async () => {
    setIsChecking(true);
    const [failure] = await Promise.all([release.check(), checkProviderUpdates()]);
    setIsChecking(false);
    if (failure === null) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Could not check for updates"),
        description: failure,
      }),
    );
  };

  const description =
    pageBehindVersion !== null
      ? gt("iglo.code {version} is installed. Reload to use it.", { version: pageBehindVersion })
      : release.version !== null
        ? gt("iglo.code {version} is available.", { version: release.version })
        : release.status === "error"
          ? (release.errorMessage ?? gt("Update check failed."))
          : release.status === "up-to-date"
            ? gt("iglo.code {version} is up to date.", { version: APP_VERSION })
            : gt("Current version of the application.");

  const control =
    pageBehindVersion !== null ? (
      <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
        {gt("Reload")}
      </Button>
    ) : release.version !== null && primaryEnvironmentId !== null ? (
      <ServerUpdateAction
        environmentId={primaryEnvironmentId}
        serverLabel={serverLabel}
        selfUpdate={resolveServerSelfUpdateCapability(serverConfig)}
        targetVersion={release.version}
        label={gt("Update")}
        size="sm"
      />
    ) : (
      <Button
        size="sm"
        variant="outline"
        disabled={release.status === "unavailable" || isChecking}
        onClick={() => void check()}
      >
        {isChecking ? gt("Checking…") : gt("Check for Updates")}
      </Button>
    );

  return (
    <SettingsRow
      id={id}
      title={<AboutVersionTitle />}
      description={description}
      managed={updatesDenial}
      control={control}
    />
  );
}
