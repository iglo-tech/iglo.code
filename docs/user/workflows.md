# Workflows

iglo.code has two workflow features that do not share files, settings or runs:

- **Visual workflows** (the Workflows plugin, [below](#visual-workflows)) are built in the app as a graph of agent steps, checks, parallel reviews and human gates. They are always available.
- **Scripted workflows** ([further down](#scripted-workflows)) are TypeScript files that chain agents, code, schedules, webhooks and questions into one durable run. They are an upstream Labs feature, off by default.

For one prompt on a timer or webhook, use a scheduled task.

## Visual workflows

A workflow is a reusable process of agent steps, checks, decisions, parallel reviews and
human gates. Each agent step runs in an ordinary thread, so its messages, tools, diffs and
approvals stay where you already work. Workflows belong to one environment and project; the
page always shows which.

### Build a workflow

Open **Workflows** from its icon at the bottom of the sidebar, **Open Workflows** in the command
palette, or the **Workflows** button in a chat's header, and choose **New workflow**. Add steps from
**Add a step**; a new step joins after the selected one. Every agent step submits a structured
report, and decisions route on its declared fields, a check's recorded result, or a review's
join. Select a step or route in the graph to edit it in the inspector; keyboard controls also
select, reorder and remove steps without dragging. Saving keeps your
draft if the connection drops or someone else saved first.

### Review in parallel

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

### Run and recover

Choose **Run workflow** in a chat's header or the library. The run view shows each visit, its thread,
whether a report was accepted, and why routing stopped. Only the actions the server allows
are offered: approve or request changes at a human gate, resume a retained session, retry, or
cancel.

### Schedule a workflow

In **Settings → Scheduled tasks**, which lists tasks from every environment, choose **New task** and the environment, set **Runs** to
**Run a workflow**, and choose the project. Pick a saved workflow, an optional task and the
workspace, then set the time or interval. Each occurrence starts the workflow as it is saved when that occurrence
runs, so later edits apply to later runs; a run that already started keeps its snapshot.
Pause, resume, edit, **Run now** and delete work as for any scheduled task. Existing tasks
also appear in the sidebar's **Scheduled** section, which opens a task in the main pane.

Open the task's menu and choose **Run history** to see recent occurrences. Each shows whether
the dispatch went out, separately from how its run is going, and **Open run** goes to that
exact run. If the Workflows plugin is unavailable, the schedule stays saved with its workflow
and task but cannot run; you can still change its timing, pause it or delete it.

### Answer what needs you

**Needs attention**, the topmost section of the thread list, shows the newest runs that need a
person with a count of all of them. Choose **more** to open the full **Attention** list, which
the **Workflows** pages also link to; pick a project in the breadcrumb to narrow it. Items are
human gates, each pending approval or question in a workflow thread, and stopped
runs with their reason. Open a request to answer it in its thread; a thread answers its
requests in order, so later ones wait for earlier ones. Each item clears only when its own
gate, request or recovery is resolved. Opening, reading or snoozing a thread does not clear
it, and a thread with a pending request cannot be snoozed.

## Scripted workflows

A scripted workflow is a TypeScript script that chains agents, plain code, schedules, webhooks, issue and pull request events, and questions to you into one durable run that survives server restarts. Each step's result is saved when it succeeds, so restarts pick up where the run left off and failures do not lose earlier work. Scripted workflows are an early upstream feature: start runs from the `iglo.code` CLI or a trigger, and follow them in the app. Their runs are separate from the visual workflows above.

Use one when work has stages, such as triage, a fix, your approval, and a release.

### Turn on scripted workflows

They are a Labs feature, off by default. Turn on **Settings → Labs → Workflows** for the server that runs them. To do it without the app, set `"workflowsEnabled": true` in `userdata/settings.json` in the iglo.code home (`~/.iglo.code` by default). While off, nothing in the workflows folder runs and `iglo.code workflow` says how to turn it on; runs are kept and continue once it is on again.

### Create a scripted workflow

Workflow files live in `~/.iglo.code/workflows/` (or wherever `IGLO_CODE_WORKFLOWS` points: a folder or a single file). The server watches the folder and reloads changes without a restart.

- **Ask an agent (recommended):** copy the repository's [`t3-workflows` skill](../../skills/t3-workflows/SKILL.md) into your agent's skills folder (such as `~/.claude/skills/` or `~/.agents/skills/`) and describe what you want.
- **Edit directly:** edit files in `~/.iglo.code/workflows/`, or use **Definitions** on the Workflows page (saving and deleting in the app require terminal access). Before anything has run, open the page with **Open scripted workflows** in the command palette.

A small workflow, saved as `~/.iglo.code/workflows/release.ts`:

```ts
const { workflow, step, ask, stop, title } = T3;

export default workflow(
  "release",
  { version: 1, payload: Schema.Struct({ name: Schema.String }) },
  Effect.fn(function* (payload) {
    yield* title(`Release ${payload.name}`);
    const notes = yield* step("notes", { returns: Schema.String }, Effect.succeed("3 fixes"));
    const answer = yield* ask("ship", {
      title: `Ship ${payload.name}? ${notes}`,
      choices: ["Ship", "Hold"],
    });
    if (Option.isNone(answer) || answer.value.choice !== "Ship") return yield* stop("held back");
    return { shipped: payload.name };
  }),
);
```

Start it with `iglo.code workflow start release --input '{"name":"v1.4"}' --key v1.4`, then answer its question in the app. `T3`, `Effect`, `Schema` and `Option` are provided (the global keeps upstream's name); a workflow file imports nothing from iglo.code or Effect. Name files with letters, digits, `-`, `_` and `.`; other names are skipped with a warning.

Saving checks that the file loads, does not duplicate a workflow name and version, and does not remove a version with unfinished runs. A file that fails these checks keeps its last working version while the Workflows page (and the server log) shows why; other files are not affected. A change held back by unfinished runs goes in by itself once those runs end or are cancelled. Mistakes inside a workflow body surface when a run hits them and pauses. To change steps while runs are unfinished, add the new body under a higher `version` and keep the old one until those runs end.

Dot-files and subfolders are ignored. Keep shared helpers in a subfolder and restart the server after editing an imported file.

### Start and steer

```sh
iglo.code workflow start <name> --input '<json>' --key <key>
iglo.code workflow list [--status paused]
iglo.code workflow show <run>
iglo.code workflow resume <run>
iglo.code workflow cancel <run> [--reason '<why>']
iglo.code workflow questions
iglo.code workflow signal '{"choice":"yes"}' --run <run> --wait <name>
iglo.code workflow signal '<json>' --workflow <name> --channel <channel>
iglo.code workflow hooks
iglo.code workflow store list
iglo.code workflow store set <key> '<json>'
```

Every start needs a `--key`: starting twice with the same key returns the same run, even after a version bump, so retries do not duplicate work. Use `signal` with `--run` and `--wait` to answer a question or wake a run, or with `--workflow` and `--channel` to wake whichever run waits on that channel. A signal for a question that is no longer open is kept for a later wait rather than refused, so check `iglo.code workflow questions` first. Use `store` to read or change state kept between runs.

### Triggers

- **Schedules:** `every` runs on an interval, starting one interval after the workflow loads; `daily` runs at a local time of day (a time missed by more than 10 minutes while the server is down is skipped).
- **Webhooks:** `iglo.code workflow hooks` prints each hook's path; prepend your server's address. The path contains the hook's secret, so share it only with the sender. A sender's retry that repeats its delivery header (such as GitHub's `X-GitHub-Delivery`) starts no second run, and bodies over 1 MiB are refused. Organization policies blocking webhook tasks block workflow webhooks too.
- **Issues and pull requests:** workflows can start on new issues or pull requests and read, comment on, or update them via **Settings → Source control & issues**, no webhook needed. iglo.code checks roughly once a minute, and only items opened after the workflow was first loaded start runs.

### Follow runs in the app

Open the Workflows page with **Open scripted workflows** in the command palette; the entry shows once a connected server has scripted workflows on. Filter by **Needs you**, **Running**, or **All** (skipped runs stay hidden unless toggled on), open child runs from their parent, and answer questions, resume paused runs, or cancel active runs (requires permission to operate threads). The issues and pull requests a run touched show as chips under its title and on the steps that touched them; a chip opens the item beside the run, in a tab next to any agent transcripts you opened.

#### Agent threads

Each `agent` step runs in an ordinary thread, left out of thread lists (including `iglo.code thread list`). Open it from the run to watch it live, read its transcript, or send follow-up messages; the thread links back to the run.

An `agent` step can launch a new thread with its own `workspace` (such as a worktree), `runtimeMode`, `interactionMode`, `title`, and typed `returns`, or continue an earlier step's thread. Runs can set their display name with `title(text)`. An `agent` step can also target a project on a [linked environment](remote-access.md#link-another-environment) (requires **Settings → Labs → Linked environments**); the run itself stays on the server that started it.

#### Failures, pause, and cancel

A plain code step runs once unless it asks for retries. When a step fails, the run pauses there instead of losing earlier work:

- **Code step failures** retry automatically after 5, 20, and 80 minutes by default, or immediately when you resume; only that step runs again.
- **Agent failures** (when an agent ran and gave up or timed out) pause and wait for you to resume rather than retrying automatically. An agent that could not be started at all, for example because its environment was offline, retries on its own like a failed step.

Cancelling a run stops its active agent turns and cancels child runs it invoked. A cancelled run cannot be resumed.

### Limits

- Runs live on the server that started them and only advance while it is running; use an always-on machine for schedules or webhooks you cannot miss.
- Keep older workflow versions defined until their unfinished runs end or are cancelled.
- Signals sent to a `channel` before a run waits on it are kept for 7 days by default.
