import type { WebPlugin } from "@t3tools/plugin-host-contract/web";
import { lazy } from "react";
import { manifest, type WorkflowClient } from "../contracts.ts";

export { authoringTimings } from "./timings.ts";

// Pages load on first visit; the manifest and navigation stay in the shell bundle.
let library: Promise<typeof import("./Library.tsx")> | undefined;
let editor: Promise<typeof import("./Editor.tsx")> | undefined;
// A failed chunk load is forgotten so the next attempt fetches it again.
const loadLibrary = () =>
  (library ??= import("./Library.tsx").catch((cause: unknown) => {
    library = undefined;
    throw cause;
  }));
const loadEditor = () =>
  (editor ??= import("./Editor.tsx").catch((cause: unknown) => {
    editor = undefined;
    throw cause;
  }));
/** Load both page modules ahead of navigation (for example on hover, or in tests). */
export const preloadWorkflowPages = () =>
  Promise.all([loadLibrary(), loadEditor()]).then(() => undefined);
const LibraryPageView = lazy(() =>
  loadLibrary().then((module) => ({ default: module.LibraryPageView })),
);
const EditorPageView = lazy(() =>
  loadEditor().then((module) => ({ default: module.EditorPageView })),
);

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
