import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, PluginPageState, PluginTarget, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { ArrowUpRightIcon } from "lucide-react";
import { msg, useGT } from "gt-react";
import { Fragment, useEffect, useState } from "react";
import { m } from "~/i18n/messages";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { RenderErrorBoundary } from "../components/RenderErrorBoundary";
import { Button } from "../components/ui/button";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { PluginIcon } from "./pluginIcons";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { projectFor, useRouteProject, type RouteProject } from "./routeProject";
import { useConnectedEnvironmentIds, useEnvironment } from "../state/environments";
import {
  availableCatalogAtom,
  attentionAtom,
  catalogAtom,
  pluginConnectedAtom,
  pluginSupportAtom,
} from "./runtime";
import { compiledWebPlugins } from "./compiled";
import { createPluginWebContext } from "./context";
import { pageCatalog, pageStatus, type RetainedCatalog } from "./pageConnection";

export function usePluginContributions(
  environmentId: EnvironmentId,
  projectId: ProjectId | null = null,
  threadId: PluginTarget["threadId"] | null = null,
  page: { readonly state?: PluginPageState; readonly retainWhileDisconnected?: boolean } = {},
) {
  const current = useAtomValue(availableCatalogAtom(environmentId));
  const connected = useAtomValue(pluginConnectedAtom(environmentId));
  const support = useAtomValue(pluginSupportAtom(environmentId));
  const catalogFailed = AsyncResult.isFailure(useAtomValue(catalogAtom(environmentId)));
  const retryCatalog = useAtomRefresh(catalogAtom(environmentId));
  const environment = useEnvironment(environmentId);
  const navigate = useNavigate();
  // A page keeps its own environment's last catalog while the connection is unreconciled
  // so drafts and snapshots stay visible; plugins gate mutations on `connection`.
  const [retained, setRetained] = useState<RetainedCatalog | null>(null);
  if (
    page.retainWhileDisconnected &&
    current !== null &&
    (retained?.catalog !== current || retained.environmentId !== environmentId)
  )
    setRetained({ environmentId, catalog: current });
  const catalog = pageCatalog(
    retained,
    environmentId,
    current,
    page.retainWhileDisconnected ?? false,
  );
  const status = pageStatus({ connected, support, catalogFailed, current });
  const connection: PluginWebContext["connection"] =
    status === "connected" ? "connected" : "disconnected";
  const label = environment?.label ?? environmentId;
  const stateKey = page.state === undefined ? "" : JSON.stringify(page.state);
  const contributions = compiledWebPlugins.flatMap((plugin) => {
    const descriptor = catalog?.plugins.find(
      (item) =>
        item.manifest.id === plugin.manifest.id &&
        item.status === "available" &&
        item.manifest.hostVersion === plugin.manifest.hostVersion,
    );
    if (descriptor === undefined) return [];
    const bound = plugin.bind(environmentId);
    const context = createPluginWebContext({
      environmentId,
      environmentLabel: label,
      descriptor,
      projectId,
      threadId,
      ...(stateKey === "" ? {} : { pageState: JSON.parse(stateKey) as PluginPageState }),
      connection,
      navigate,
    });
    return [{ ...bound, context }];
  });
  return { catalog, contributions, connection, status, retryCatalog };
}

/** Links to pages this client or server does not contribute stay visible but unavailable. */
const pageAvailable = (
  plugin: ReturnType<typeof usePluginContributions>["contributions"][number],
  pageId: string,
) =>
  plugin.pages.some((page) => page.id === pageId) &&
  plugin.context.descriptor.manifest.web.pages.includes(pageId);

function EnvironmentPluginItems({
  environmentId,
  labelEnvironment,
  route,
}: {
  environmentId: EnvironmentId;
  labelEnvironment: boolean;
  route: RouteProject | null;
}) {
  const { contributions } = usePluginContributions(environmentId);
  const environment = useEnvironment(environmentId);
  const params = useParams({ strict: false });
  const { isMobile, setOpenMobile } = useSidebar();
  return contributions.flatMap((plugin) => {
    const entries = plugin.navigation.filter((item) =>
      plugin.context.descriptor.manifest.web.navigation.includes(item.id),
    );
    // The current plugin page, from route params. An entry is active on its own page; on a
    // page no entry links to (an editor reached from a library), the plugin's first entry is.
    const page =
      "pluginId" in params &&
      params.pluginId === plugin.manifest.id &&
      "environmentId" in params &&
      params.environmentId === environmentId &&
      "pageId" in params
        ? params.pageId
        : undefined;
    const exact = entries.some((item) => item.link.pageId === page);
    return entries.map((item, index) => {
      const label = labelEnvironment
        ? `${item.title} · ${environment?.label ?? environmentId}`
        : item.title;
      const active = page !== undefined && (exact ? item.link.pageId === page : index === 0);
      return (
        <SidebarMenuItem key={`${environmentId}:${item.id}`} className="shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  aria-label={label}
                  size="icon"
                  isActive={active}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                    // Like project actions, entries open in the project the user is in.
                    const projectId = projectFor(route, environmentId);
                    plugin.context.navigate(
                      item.link.projectId === undefined && projectId !== undefined
                        ? { ...item.link, projectId }
                        : item.link,
                    );
                  }}
                >
                  <PluginIcon name={item.icon} />
                </SidebarMenuButton>
              }
            />
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        </SidebarMenuItem>
      );
    });
  });
}

/** Plugin navigation as icon entries beside the sidebar's Settings, Pull Requests and Usage. */
export function PluginSidebarItems() {
  const environmentIds = useConnectedEnvironmentIds();
  const route = useRouteProject();
  return environmentIds.map((environmentId) => (
    <EnvironmentPluginItems
      key={environmentId}
      environmentId={environmentId}
      labelEnvironment={environmentIds.length > 1}
      route={route}
    />
  ));
}

/** Newest items listed in the sidebar; the plugin's attention view lists the rest. */
const ATTENTION_SHOWN = 5;
const ATTENTION_EXPANDED_KEY = "t3code:sidebar:attention-expanded";

function EnvironmentPluginAttention({
  environmentId,
  labelEnvironment,
}: {
  environmentId: EnvironmentId;
  labelEnvironment: boolean;
}) {
  const gt = useGT();
  const { contributions } = usePluginContributions(environmentId);
  const environment = useEnvironment(environmentId);
  const attention = useAtomValue(attentionAtom(environmentId));
  const { isMobile, setOpenMobile } = useSidebar();
  const [expanded, setExpanded] = useLocalStorage(ATTENTION_EXPANDED_KEY, true, Schema.Boolean);
  const summaries = Option.getOrElse(AsyncResult.value(attention), () => []);
  return summaries.flatMap((summary) => {
    const plugin = contributions.find((item) => item.manifest.id === summary.pluginId);
    if (plugin === undefined) return [];
    // The plugin's own total; a capped item list is never presented as the count.
    const count = summary.total ?? (summary.items.length >= 100 ? null : summary.items.length);
    if (count === 0 && summary.error === undefined) return [];
    const view = plugin.attention;
    // The plugin's own attention view, when this client can open it.
    const target = view !== null && pageAvailable(plugin, view.link.pageId) ? view : null;
    const shown = summary.items.slice(0, ATTENTION_SHOWN);
    const more = (count ?? summary.items.length) - shown.length;
    const prefix = labelEnvironment ? `${environment?.label ?? environmentId} · ` : "";
    const label = `${prefix}Needs attention${summaries.length > 1 ? ` · ${view?.title ?? plugin.manifest.displayName}` : ""}`;
    const open = (link: Parameters<typeof plugin.context.navigate>[0]) => {
      if (isMobile) setOpenMobile(false);
      plugin.context.navigate(link);
    };
    return [
      <li key={`${summary.pluginId}:header`} className="mx-0.5 flex list-none items-center gap-0.5">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader
            expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            accessory={<span className="font-normal tabular-nums">{count ?? "100+"}</span>}
          >
            {label}
          </CollapsibleSectionHeader>
        </div>
        {/* The full view stays reachable when every item already fits in the sidebar. */}
        {target === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={gt("View all: {section}", { section: label })}
                  onClick={() => open(target.link)}
                >
                  <ArrowUpRightIcon />
                </Button>
              }
            />
            <TooltipPopup side="top">{gt("View all")}</TooltipPopup>
          </Tooltip>
        )}
      </li>,
      ...(!expanded
        ? []
        : [
            ...(summary.error === undefined
              ? []
              : [
                  <SidebarMenuItem key={`${summary.pluginId}:error`}>
                    <p role="status" className="truncate px-2 text-xs text-destructive">
                      {plugin.manifest.displayName}: {summary.error.message}
                    </p>
                  </SidebarMenuItem>,
                ]),
            ...shown.map((item) => {
              const available = pageAvailable(plugin, item.link.pageId);
              return (
                <SidebarMenuItem key={`${summary.pluginId}:${item.id}`}>
                  <SidebarMenuButton
                    size="sm"
                    disabled={!available}
                    title={
                      available
                        ? `${item.summary} · ${item.reason}`
                        : gt("This page is not available in this client.")
                    }
                    onClick={() => open(item.link)}
                  >
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
                    <span className="min-w-0 truncate">{item.summary}</span>
                    {/* The reason gives way first so the summary stays readable. */}
                    <span className="ml-auto min-w-0 shrink-[3] truncate text-muted-foreground">
                      {item.reason}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }),
            ...(more > 0
              ? [
                  <SidebarMenuItem key={`${summary.pluginId}:more`}>
                    {target !== null ? (
                      <SidebarMenuButton size="sm" onClick={() => open(target.link)}>
                        <span className="min-w-0 truncate text-muted-foreground">
                          {more}
                          {count === null ? "+" : ""} more
                        </span>
                      </SidebarMenuButton>
                    ) : (
                      <p className="truncate px-2 text-xs text-muted-foreground">
                        {more}
                        {count === null ? "+" : ""} more
                      </p>
                    )}
                  </SidebarMenuItem>,
                ]
              : []),
          ]),
    ];
  });
}

/** The thread list's topmost section; nothing renders when nothing needs action. */
export function PluginSidebarAttention() {
  const environmentIds = useConnectedEnvironmentIds();
  return (
    <SidebarMenu className="mb-1 empty:hidden">
      {environmentIds.map((environmentId) => (
        <EnvironmentPluginAttention
          key={environmentId}
          environmentId={environmentId}
          labelEnvironment={environmentIds.length > 1}
        />
      ))}
    </SidebarMenu>
  );
}

/** Tells the user a project action dialog failed, then closes it. */
function ProjectActionFailed({ title, setOpen }: { title: string; setOpen: (open: null) => void }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fires a toast and closes the action once for a failed project action.
  useEffect(() => {
    toastManager.add({ type: "error", title: m(msg("Couldn't open {title}", { title })) });
    setOpen(null);
  }, [title, setOpen]);
  return null;
}

export function PluginProjectActions({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  // The action whose dialog is open over the current view.
  const [open, setOpen] = useState<{ pluginId: string; actionId: string } | null>(null);
  // An open dialog survives a connection drop so its draft stays; the plugin gates mutations.
  const { contributions } = usePluginContributions(environmentId, projectId, null, {
    retainWhileDisconnected: open !== null,
  });
  return (
    <div className="[app-region:no-drag] flex shrink-0 items-center gap-0.5">
      {contributions.flatMap((plugin) =>
        plugin.projectActions
          .filter((item) => plugin.context.descriptor.manifest.web.projectActions.includes(item.id))
          .map((item) => (
            <Fragment key={item.id}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={item.title}
                      onClick={() =>
                        item.dialog === undefined
                          ? plugin.context.navigate(item.link(projectId))
                          : setOpen({ pluginId: plugin.manifest.id, actionId: item.id })
                      }
                    >
                      <PluginIcon name={item.icon} />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">{item.title}</TooltipPopup>
              </Tooltip>
              {item.dialog !== undefined &&
              open?.pluginId === plugin.manifest.id &&
              open.actionId === item.id ? (
                // A failed chunk or render shows a toast and closes; reopening resets it.
                <RenderErrorBoundary
                  fallback={<ProjectActionFailed title={item.title} setOpen={setOpen} />}
                  resetKeys={[open]}
                >
                  {item.dialog(plugin.context, () => setOpen(null))}
                </RenderErrorBoundary>
              ) : null}
            </Fragment>
          )),
      )}
    </div>
  );
}

export function PluginThreadContext({ target }: { target: PluginTarget }) {
  const { contributions } = usePluginContributions(
    target.environmentId,
    target.projectId,
    target.threadId,
  );
  return (
    <div className="[app-region:no-drag] flex shrink-0 gap-1">
      {contributions.flatMap((plugin) =>
        plugin.threadContext
          .filter((item) => plugin.context.descriptor.manifest.web.threadContext.includes(item.id))
          .map((item) => (
            <RenderErrorBoundary key={item.id} fallback={null} resetKeys={[plugin.context]}>
              <div>{item.render(plugin.context)}</div>
            </RenderErrorBoundary>
          )),
      )}
    </div>
  );
}
