import { expect, it } from "@effect/vitest";
import { coreMcpToolNames } from "./coreMcpToolNames.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";

it("covers every compiled core tool without approving plugin namespaces", () => {
  const approved = new Set(coreMcpToolNames);
  const native = [
    ...Object.keys(OrchestratorToolkit.tools),
    ...Object.keys(PreviewToolkit.tools),
    ...Object.keys(WorktreeToolkit.tools),
    ...Object.keys(ThreadToolkit.tools),
    ...Object.keys(AttachmentToolkit.tools),
    ...Object.keys(ProjectToolkit.tools),
    ...Object.keys(EnvironmentToolkit.tools),
    ...Object.keys(PreviewControlsToolkit.tools),
    ...Object.keys(DeviceToolkit.tools),
    ...Object.keys(PullRequestsToolkit.tools),
  ];
  expect(native.filter((name) => !approved.has(name))).toEqual([]);
  expect(coreMcpToolNames.some((name) => name.startsWith("plugin_"))).toBe(false);
});
