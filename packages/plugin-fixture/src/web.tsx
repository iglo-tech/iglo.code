import type { PluginWebContext, WebPlugin } from "@t3tools/plugin-host-contract/web";
import { useEffect, useState } from "react";
import { manifest, type FixtureClient, type Report } from "./contracts.ts";

function ReportsPage(props: PluginWebContext & { readonly client: FixtureClient }) {
  return (
    <ReportsView key={`${props.environmentId}:${props.projectId}:${props.threadId}`} {...props} />
  );
}
function ReportsView({
  client,
  projectId,
  threadId,
  environmentId,
  openThread,
  Button,
}: PluginWebContext & { readonly client: FixtureClient }) {
  const [reports, setReports] = useState<ReadonlyArray<Report> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    return client.subscribe(
      { ...(projectId === null ? {} : { projectId }), ...(threadId === null ? {} : { threadId }) },
      setReports,
      setError,
    );
  }, [client, projectId, threadId]);
  const perform = (id: string, run: () => Promise<unknown>) => {
    setPending(id);
    setError(null);
    void run()
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "The action failed. Reconnect to this environment and try again.",
        ),
      )
      .finally(() => setPending(null));
  };
  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Agent reports stay open until you resolve them. Opening a conversation leaves its report
        open.
      </p>
      {error === null ? null : (
        <p role="alert" className="mt-6 text-sm text-destructive">
          {error}
        </p>
      )}
      {reports === null ? (
        <p role="status" className="mt-8 text-sm text-muted-foreground">
          Loading reports…
        </p>
      ) : reports.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">No reports in this view.</p>
      ) : (
        <ul className="mt-8 divide-y divide-border">
          {reports.map((report) => (
            <li key={report.id} className="py-5">
              <div className="flex items-start justify-between gap-4">
                <p className="min-w-0 break-words text-sm font-medium">{report.summary}</p>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {report.resolved ? "Resolved" : "Open"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    openThread({
                      environmentId,
                      projectId: report.projectId,
                      threadId: report.threadId,
                    })
                  }
                >
                  Open conversation
                </Button>
                {report.resolved ? null : (
                  <Button
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => perform(report.id, () => client.resolve(report.id))}
                  >
                    {pending === report.id ? "Saving…" : "Resolve"}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => perform(report.id, () => client.schedule(report.id, 3_600_000))}
                >
                  Remind hourly
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const web: WebPlugin<FixtureClient> = {
  manifest,
  pages: [{ id: "fixture.reports", title: "Reports", component: ReportsPage }],
  navigation: [{ id: "fixture.navigation", title: "Reports", link: { pageId: "fixture.reports" } }],
  projectActions: [
    {
      id: "fixture.reports-action",
      title: "Reports",
      link: (projectId) => ({ pageId: "fixture.reports", projectId }),
    },
  ],
  threadContext: [
    {
      id: "fixture.thread-reports",
      render: (context) => (
        <context.Button
          variant="ghost"
          size="sm"
          onClick={() =>
            context.navigate({
              pageId: "fixture.reports",
              ...(context.projectId === null ? {} : { projectId: context.projectId }),
              ...(context.threadId === null ? {} : { threadId: context.threadId }),
            })
          }
        >
          Reports
        </context.Button>
      ),
    },
  ],
};
