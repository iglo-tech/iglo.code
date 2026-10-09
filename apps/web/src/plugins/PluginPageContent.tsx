import type { PluginCatalog } from "@t3tools/contracts";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { useCallback, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import type { bind } from "./contributions";
import { PluginPageStatusStrip } from "./design";
import { PluginPageChromeContext, type PluginPageChrome } from "./pageChrome";
import { missingPageMessage, type PluginPageStatus } from "./pageConnection";

export function PluginPageContent({
  catalog,
  contributions,
  pluginId,
  pageId,
  electron = false,
  showEnvironment = false,
  status = "connected",
  onRetryCatalog,
}: {
  readonly catalog: PluginCatalog | null;
  readonly contributions: ReadonlyArray<
    ReturnType<typeof bind> & { readonly context: PluginWebContext }
  >;
  readonly pluginId: string;
  readonly pageId: string;
  readonly electron?: boolean;
  /** More than one environment is connected, so pages name theirs in the breadcrumb. */
  readonly showEnvironment?: boolean;
  readonly status?: PluginPageStatus;
  readonly onRetryCatalog?: () => void;
}) {
  const plugin = contributions.find((item) => item.manifest.id === pluginId);
  const page = plugin?.pages.find(
    (item) => item.id === pageId && plugin.context.descriptor.manifest.web.pages.includes(item.id),
  );
  const descriptor = catalog?.plugins.find((item) => item.manifest.id === pluginId);
  const missing = missingPageMessage({ status, descriptor });
  // A page that renders its own header (PageHeader) replaces the host title bar and scrolls
  // its own content; until then (including while its module loads) the host shows the title.
  const [headers, setHeaders] = useState(0);
  const claimHeader = useCallback(() => {
    setHeaders((count) => count + 1);
    return () => setHeaders((count) => count - 1);
  }, []);
  const environmentLabel = plugin?.context.environmentLabel ?? "";
  const chrome = useMemo<PluginPageChrome>(
    () => ({
      electron,
      environmentLabel,
      showEnvironment,
      status,
      claimHeader,
      ...(onRetryCatalog === undefined ? {} : { onRetryCatalog }),
    }),
    [electron, environmentLabel, showEnvironment, status, claimHeader, onRetryCatalog],
  );
  const ownHeader = page !== undefined && headers > 0;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <PluginPageChromeContext value={chrome}>
        {ownHeader ? null : (
          <>
            <WorkspacePageHeader electron={electron}>
              <span className="text-sm font-medium">{page?.title ?? missing.title}</span>
            </WorkspacePageHeader>
            {page === undefined ? null : <PluginPageStatusStrip chrome={chrome} />}
          </>
        )}
        <main
          className={
            ownHeader
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
          }
        >
          {page !== undefined && plugin !== undefined ? (
            page.render(plugin.context)
          ) : (
            <div className="mx-auto max-w-xl px-6 py-12">
              <h1 className="text-lg font-semibold">{missing.title}</h1>
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                {missing.text}
              </p>
              {missing.retry && onRetryCatalog !== undefined ? (
                <div className="mt-4">
                  <Button size="sm" variant="outline" onClick={onRetryCatalog}>
                    Retry
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </main>
      </PluginPageChromeContext>
    </SidebarInset>
  );
}
