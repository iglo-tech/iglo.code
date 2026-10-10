import type { WebPlugin } from "@t3tools/plugin-host-contract/web";
import { createElement, lazy, Suspense } from "react";
import { manifest, type WorkflowClient } from "../contracts.ts";

export { authoringTimings } from "./timings.ts";

// Pages load on first visit; the manifest and navigation stay in the shell bundle.
// A failed chunk load is forgotten so the next attempt fetches it again.
const loader = <M,>(load: () => Promise<M>) => {
  let pending: Promise<M> | undefined;
  return () =>
    (pending ??= load().catch((cause: unknown) => {
      pending = undefined;
      throw cause;
    }));
};
const loadLibrary = loader(() => import("./Library.tsx"));
const loadEditor = loader(() => import("./Editor.tsx"));
const loadRuns = loader(() => import("./Runs.tsx"));
const loadThread = loader(() => import("./ThreadContext.tsx"));
const loadAttention = loader(() => import("./Attention.tsx"));
/** Load the page modules ahead of navigation (for example on hover, or in tests). */
export const preloadWorkflowPages = () =>
  Promise.all([loadLibrary(), loadEditor(), loadRuns(), loadThread(), loadAttention()]).then(
    () => undefined,
  );
const LibraryPageView = lazy(() =>
  loadLibrary().then((module) => ({ default: module.LibraryPageView })),
);
const EditorPageView = lazy(() =>
  loadEditor().then((module) => ({ default: module.EditorPageView })),
);
const RunsPageView = lazy(() => loadRuns().then((module) => ({ default: module.RunsPageView })));
const AttentionPageView = lazy(() =>
  loadAttention().then((module) => ({ default: module.AttentionPageView })),
);
const ThreadContextView = lazy(() =>
  loadThread().then((module) => ({ default: module.ThreadContextView })),
);

/** Workflow pages: library, editor and runs, bound to the host's selected environment. */
export const web: WebPlugin<WorkflowClient> = {
  manifest,
  pages: [
    { id: "workflows.library", title: "Workflows", component: LibraryPageView },
    { id: "workflows.editor", title: "Workflow editor", component: EditorPageView },
    { id: "workflows.runs", title: "Workflow runs", component: RunsPageView },
    { id: "workflows.attention", title: "Workflow attention", component: AttentionPageView },
  ],
  navigation: [
    {
      id: "workflows.navigation",
      title: "Workflows",
      icon: "workflow",
      link: { pageId: "workflows.library" },
    },
    {
      id: "workflows.attention-navigation",
      title: "Workflow attention",
      icon: "inbox",
      link: { pageId: "workflows.attention" },
    },
  ],
  attention: { title: "Workflows", link: { pageId: "workflows.attention" } },
  projectActions: [
    {
      id: "workflows.project",
      title: "Workflows",
      icon: "workflow",
      link: (projectId) => ({ pageId: "workflows.library", projectId }),
    },
    {
      id: "workflows.project-run",
      title: "Run workflow",
      icon: "play",
      link: (projectId) => ({ pageId: "workflows.runs", projectId, state: { start: "1" } }),
    },
  ],
  threadContext: [
    {
      id: "workflows.thread",
      // The strip renders nothing for threads no workflow owns.
      render: (context) =>
        createElement(Suspense, { fallback: null }, createElement(ThreadContextView, context)),
    },
  ],
};
