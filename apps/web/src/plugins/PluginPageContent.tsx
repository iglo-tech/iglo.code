import type { PluginCatalog } from "@t3tools/contracts";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import type { bind } from "./contributions";
import { missingPageMessage, type PluginPageStatus } from "./pageConnection";
const statusText: Record<Exclude<PluginPageStatus, "connected">, string> = {
  disconnected:
    "Disconnected from this environment. Showing the last loaded state; changes wait until it reconnects.",
  reconciling:
    "Reconnecting to this environment. Showing the last loaded state; changes wait until it reconciles.",
  unsupported:
    "This environment does not support plugins. Showing the last loaded state; changes are unavailable.",
  "catalog-unavailable":
    "This environment's plugin catalog could not be loaded. Showing the last loaded state; changes wait until it loads.",
};

export function PluginPageContent({
  catalog,
  contributions,
  pluginId,
  pageId,
  electron = false,
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
  readonly status?: PluginPageStatus;
  readonly onRetryCatalog?: () => void;
}) {
  const plugin = contributions.find((item) => item.manifest.id === pluginId);
  const page = plugin?.pages.find(
    (item) => item.id === pageId && plugin.context.descriptor.manifest.web.pages.includes(item.id),
  );
  const descriptor = catalog?.plugins.find((item) => item.manifest.id === pluginId);
  const missing = missingPageMessage({ status, descriptor });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={electron}>
        <span className="text-sm font-medium">{page?.title ?? missing.title}</span>
      </WorkspacePageHeader>
      {page === undefined || status === "connected" ? null : (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-border bg-warning/8 px-6 py-2 text-sm"
        >
          <span>{statusText[status]}</span>
          {status === "catalog-unavailable" && onRetryCatalog !== undefined ? (
            <Button size="sm" variant="outline" onClick={onRetryCatalog}>
              Retry
            </Button>
          ) : null}
        </div>
      )}
      <main className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
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
    </SidebarInset>
  );
}
