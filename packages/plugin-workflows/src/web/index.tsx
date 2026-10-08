import type { WebPlugin } from "@t3tools/plugin-host-contract/web";
import { manifest, type WorkflowClient } from "../contracts.ts";
import { EditorPageView } from "./Editor.tsx";

export { authoringTimings } from "./common.tsx";
import { LibraryPageView } from "./Library.tsx";

/** Workflow pages: one library and one editor, bound to the host's selected environment. */
export const web: WebPlugin<WorkflowClient> = {
  manifest,
  pages: [
    { id: "workflows.library", title: "Workflows", component: LibraryPageView },
    { id: "workflows.editor", title: "Workflow editor", component: EditorPageView },
  ],
  navigation: [
    { id: "workflows.navigation", title: "Workflows", link: { pageId: "workflows.library" } },
  ],
  projectActions: [
    {
      id: "workflows.project",
      title: "Workflows",
      link: (projectId) => ({ pageId: "workflows.library", projectId }),
    },
  ],
  threadContext: [],
};
