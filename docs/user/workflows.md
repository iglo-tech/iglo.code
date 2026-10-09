# Workflows

A workflow is a reusable process of agent steps, checks, decisions, parallel reviews and
human gates. Each agent step runs in an ordinary thread, so its messages, tools, diffs and
approvals stay where you already work. Workflows belong to one environment and project; the
page always shows which.

## Build a workflow

Open **Workflows** from the project navigation and choose **New workflow**. Add steps from
**Add a step**; a new step joins after the selected one. Every agent step submits a structured
report, and decisions route on its declared fields, a check's recorded result, or a review's
join. Switch the canvas to **Routes** to read or edit every route without dragging. Saving keeps your
draft if the connection drops or someone else saved first.

## Review in parallel

A **Parallel group** freezes one pull request's committed head when it starts and gives each
reviewer its own isolated worktree at that commit. Add reviewers with their own label, skill,
focus and deadline; two reviewers can use the same skill. Reviewers always work in plan mode
and ask before external actions.

The group's **Wait for all** join decides only after every reviewer settles. An accepted
report is not a settled reviewer: three reports with one reviewer still running is still
waiting, and an early "changes" verdict does not stop the others. Join rules can read the
result (`all_completed`, `failed`, `unresolved`, `canceled` or `stale`) and each reviewer's
report.

If the pull request head changes or cannot be verified, the review becomes stale instead of
being used. Choose **Rerun review** in the run to start a new generation
on the newly verified commit. Earlier generations keep their threads and evidence. Nothing is
merged automatically.

## Run and recover

Choose **Run workflow** from the project or library. The run view shows each visit, its thread,
whether a report was accepted, and why routing stopped. Only the actions the server allows
are offered: approve or request changes at a human gate, resume a retained session, retry, or
cancel.

## Schedule a workflow

In **Settings → Scheduled tasks**, choose **New task** and the environment, set **Runs** to
**Run a workflow**, and choose the project. Pick a saved workflow, an optional task and the
workspace, then set the time or interval. Each occurrence starts the workflow as it is saved when that occurrence
runs, so later edits apply to later runs; a run that already started keeps its snapshot.
Pause, resume, edit, **Run now** and delete work as for any scheduled task.

Open the task's menu and choose **Run history** to see recent occurrences. Each shows whether
the dispatch went out, separately from how its run is going, and **Open run** goes to that
exact run. If the Workflows plugin is unavailable, the schedule stays saved with its workflow
and task but cannot run; you can still change its timing, pause it or delete it.

## Answer what needs you

**Workflow attention** lists the runs that need a person, newest first, with a count of all
of them; when there are more than it can show, pick a project in the breadcrumb to narrow the list. Items are
human gates, each pending approval or question in a workflow thread, and stopped
runs with their reason. Open a request to answer it in its thread; a thread answers its
requests in order, so later ones wait for earlier ones. Each item clears only when its own
gate, request or recovery is resolved. Opening, reading or snoozing a thread does not clear
it, and a thread with a pending request cannot be snoozed.
