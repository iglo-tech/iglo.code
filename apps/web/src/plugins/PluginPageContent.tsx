import type { PluginCatalog } from "@t3tools/contracts";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import type { bind } from "./contributions";
export function PluginPageContent({
  catalog,
  contributions,
  pluginId,
  pageId,
  electron = false,
}: {
  readonly catalog: PluginCatalog | null;
  readonly contributions: ReadonlyArray<
    ReturnType<typeof bind> & { readonly context: PluginWebContext }
  >;
  readonly pluginId: string;
  readonly pageId: string;
  readonly electron?: boolean;
}) {
  const plugin = contributions.find((item) => item.manifest.id === pluginId);
  const page = plugin?.pages.find(
    (item) => item.id === pageId && plugin.context.descriptor.manifest.web.pages.includes(item.id),
  );
  const descriptor = catalog?.plugins.find((item) => item.manifest.id === pluginId);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={electron}>
        <span className="text-sm font-medium">{page?.title ?? "Plugin unavailable"}</span>
      </WorkspacePageHeader>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {page !== undefined && plugin !== undefined ? (
          page.render(plugin.context)
        ) : (
          <div className="mx-auto max-w-xl px-6 py-12">
            <h1 className="text-lg font-semibold">Plugin unavailable</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              {descriptor?.reason ??
                (descriptor?.status === "available"
                  ? "This page is not included in this client build."
                  : "Connect to the selected environment with a compatible plugin build.")}
            </p>
          </div>
        )}
      </main>
    </SidebarInset>
  );
}
