import type { useNavigate } from "@tanstack/react-router";
import type {
  EnvironmentId,
  PluginDescriptor,
  PluginPageLink,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { Button } from "../components/ui/button";
export function createPluginWebContext(
  environmentId: EnvironmentId,
  descriptor: PluginDescriptor,
  projectId: ProjectId | null,
  threadId: ThreadId | null,
  navigate: ReturnType<typeof useNavigate>,
): PluginWebContext {
  const openPage = (link: PluginPageLink) => {
    void navigate({
      to: "/plugins/$environmentId/$pluginId/$pageId",
      params: { environmentId, pluginId: descriptor.manifest.id, pageId: link.pageId },
      search: { pluginProjectId: link.projectId, pluginThreadId: link.threadId },
    });
  };
  const context: PluginWebContext = {
    environmentId,
    descriptor,
    projectId,
    threadId,
    Button,
    navigate: openPage,
    openThread: (target) => {
      if (target.environmentId !== environmentId) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: target.threadId },
      });
    },
  };
  return context;
}
