import type { useNavigate } from "@tanstack/react-router";
import type {
  EnvironmentId,
  PluginDescriptor,
  PluginPageLink,
  PluginPageState,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { PluginDesign, PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { pluginDesign } from "./design";
import { createPluginDraftStore } from "./drafts";

const browserStorage = () => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function createPluginWebContext(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string;
  readonly descriptor: PluginDescriptor;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly pageState?: PluginPageState;
  readonly connection?: PluginWebContext["connection"];
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly design?: Partial<PluginDesign>;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}): PluginWebContext {
  const { environmentId, descriptor, navigate } = input;
  const openPage = (link: PluginPageLink, options?: { readonly replace?: boolean }) => {
    void navigate({
      to: "/plugins/$environmentId/$pluginId/$pageId",
      params: { environmentId, pluginId: descriptor.manifest.id, pageId: link.pageId },
      search: {
        pluginProjectId: link.projectId,
        pluginThreadId: link.threadId,
        pluginState: link.state,
      },
      ...(options?.replace ? { replace: true } : {}),
    });
  };
  return {
    ...pluginDesign,
    ...input.design,
    environmentId,
    environmentLabel: input.environmentLabel ?? environmentId,
    descriptor,
    projectId: input.projectId,
    threadId: input.threadId,
    pageState: input.pageState ?? {},
    connection: input.connection ?? "connected",
    drafts: createPluginDraftStore(
      input.storage === undefined ? browserStorage() : input.storage,
      environmentId,
      descriptor.manifest.id,
    ),
    navigate: openPage,
    openThread: (target) => {
      if (target.environmentId !== environmentId) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: target.threadId },
      });
    },
  };
}
