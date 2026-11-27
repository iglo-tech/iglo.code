# Source control

iglo.code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, Cursor Origin, Linear, and Jira Cloud to clone/publish repos, review and merge pull requests, manage issues, and watch CI.

## Connect an account

Install Git and authenticate on the machine running your iglo.code server (for remote environments, do this on the remote machine), then click **Rescan** in **Settings → Source control & issues**.

| Host                               | Setup                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                         | 1) Save a token in **Settings → Source control & issues → GitHub**, 2) set `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` + `GH_HOST` for Enterprise), or 3) sign in with [GitHub CLI](https://cli.github.com/) 2.81.0+ (`gh auth login`; use `--hostname` for Enterprise). Pick accounts or disable hosts in Settings when multiple `gh` logins exist.                                                                                         |
| **GitLab**                         | Install [GitLab CLI](https://gitlab.com/gitlab-org/cli) and run `glab auth login`.                                                                                                                                                                                                                                                                                                                                                 |
| **Forgejo / Gitea**                | Install [`fj`](https://codeberg.org/forgejo-contrib/forgejo-cli) (`fj --host https://your-server auth add-token`) or [`gt`](https://gitea.com/gitea/cli) 2.0+ (`gt auth login --host https://your-server`; it replaces the archived `tea`, so sign in again). Prefers `fj`, falls back to `gt` (use `gt` for subpath-hosted servers). Use full URLs when multiple servers exist.                                                   |
| **Bitbucket**                      | Save a repo/project/workspace **Access token** or **Atlassian email + API token** (with repo/PR read-write, `read:user:bitbucket`, `read:workspace:bitbucket`) in **Settings → Source control & issues → Bitbucket**, or set `IGLO_CODE_BITBUCKET_ACCESS_TOKEN` / `IGLO_CODE_BITBUCKET_EMAIL` + `IGLO_CODE_BITBUCKET_API_TOKEN` in the server env (or [`service.env`](./background-service.md#configure-the-service-environment)). |
| **Azure DevOps**                   | Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), run `az extension add --name azure-devops`, then `az login`.                                                                                                                                                                                                                                                                                                    |
| **GitCafe**                        | Save a token in Settings, set `CAFE_TOKEN` (+ `CAFE_HOST`), or install `@gitcafe/cli` and run `cafe auth login --host https://git.cafe/api`. Line comments are not yet supported; stack merges/updates are native.                                                                                                                                                                                                                 |
| **Cursor Origin**                  | Install [Origin CLI](https://cursor.com/docs/origin/cli) and run `origin auth login` (`origin auth setup-git` if push prompts for credentials). Uses private HTTPS repos; GitHub-mirrored PRs stay on GitHub.                                                                                                                                                                                                                      |
| **TanStack Source** (private beta) | Set `IGLO_CODE_FEATURE_FLAGS=tanstack_source` and restart the server. Save a token in Settings, set `SRC_TOKEN`, or run `src auth login --web`. Supports live CI logs, private PRs on public repos, and issues.                                                                                                                                                                                                                    |

> Note: Git `push` and `clone` still require Git SSH/HTTPS credentials on the server, separate from API tokens.

> Note: With several `gt` servers and no `fj` login, `owner/repo` and newly published repositories go to `gt`'s default server (`gt config set default_host https://your-server`). With several `gt` accounts on one server, pick one with `gt auth switch <user> --host https://your-server`. If an SSH remote uses a different host name than the server's web address, run `gt config set ssh_host <ssh-host> --host https://your-server`.

## Start, clone, or publish a project

- **New project**: Run **New project** from the command palette (`Cmd/Ctrl+K`) or **Add Project** to initialize a new Git repo in `~/.iglo.code/projects/<slug>` with a README, icon, and first commit (optionally creating a private GitHub repo).
- **Clone**: Use **Add Project** to pick a host (enable non-GitHub hosts in **Settings → Source control & issues**) or paste a Git URL or web page URL. Cloning runs in the background so you can draft your first prompt immediately; falls back to HTTPS if SSH auth fails. Enable **Clone into host folders** (**Settings → Threads**) for `ghq`-style `<host>/<owner>/<repo>` paths.
- **Publish**: For a local repo without a remote, **Publish Repository** creates the remote, adds `origin`, and pushes commits.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

In a [project with several repositories](multi-repo-projects.md),
the Diff pane shows every repository the turn changed. Use the repository picker next to the source picker to narrow the diff to one of
them. Paths in the diff start at the thread's folder, so the same file name in two repositories
stays apart. This works when the project folder itself is not a Git repository; the branch
comparison and uncommitted changes read one repository at a time, chosen from the same picker.

The thread details panel lists each repository the thread has changed, most recent first, with its
branch and uncommitted changes. Expand one to commit, push, or open a pull request in that
repository; a pull request opened there, or already open for its branch when a turn ends, is linked
to the thread. **Other repositories...** adds any other repository of the project to the list until you
reload. In a worktree thread of a project with several repositories it adds a worktree of that
repository to the thread instead; see [Worktree threads](multi-repo-projects.md#worktree-threads). A
worktree thread of a single repository does not offer it.

Open the Diff pane source picker and choose **Commits** to review one local
commit at a time. The list shows the newest 100 commits in the branch comparison. A merge commit
shows its changes against its first parent.

A commit link from a supported code host opens in the Diff pane when the thread's repository has
that commit locally, on any branch. Otherwise a pull request commit link opens the pull request. Other
commit links follow your **Open links in** setting; on web, when that opens a new tab, iglo.code first
shows an **Open link** button. Command/Ctrl+Click always opens the link in your browser. Commit links follow the **Open pull requests in iglo.code**
setting in **Settings → Diffs**.

## Connect an account

Install Git and configure authentication on the machine running your iglo.code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source control & issues**
and choose **Rescan**.

### GitHub

iglo.code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source control & issues → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. iglo.code treats a
custom server name as GitHub once it has a credential for that host.

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`gt`)](https://gitea.com/gitea/cli) 2.0 or later on your iglo.code server.
Sign in with `fj --host https://your-server auth add-token` or `gt auth login --host https://your-server`. `gt` replaces the archived `tea`, so sign in again if you used `tea` before.
Repeat for each server you use, including Codeberg.

iglo.code prefers a matching `fj` login and falls back to `gt` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `gt` because
fj does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `gt`
server when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
With several `gt` servers and no `fj` login, `owner/repo` and newly published repositories go to `gt`'s default server; set it with `gt config set default_host https://your-server`. If you have several `gt` accounts on one server, select one with
`gt auth switch <user> --host https://your-server`. If an SSH remote uses a different host name than the server's web address, run `gt config set ssh_host <ssh-host> --host https://your-server`. Git push and clone also need Git credentials or an SSH key
for that server.

Open **Issues** from the sidebar utility row or **Open issues** in the command palette to browse, filter, search, save views, comment, edit, and transition issues across GitHub, GitLab, Azure DevOps, Forgejo, Linear, and Jira Cloud.

- **Linear**: Connect an API key in **Settings → Source control & issues** and bind one or more teams per project (supports multiple Linear accounts). Agents file new issues in the first bound team unless another is named. An issue linked by its full URL needs no binding: any thread, No project threads included, can open and change an issue from a connected workspace, as far as your Linear account allows.
- **Jira Cloud**: Connect your site (`yourteam.atlassian.net`), account email, and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) in **Settings → Source control & issues**, then bind Jira projects (supports multiple Jira sites and accounts). Issues move along their workflow's transitions; reactions and linked pull requests are not available, and new issues are filed as a Task. On a Jira Service Management issue, a comment is an **Internal note** the customer never sees unless you switch it to **Reply to customer** before sending.
- **Link to threads**: Click **Link to this thread** on an issue beside a thread (or let agents call `link_issue`) to track it in **Linked items**.
- Remote issue writes require the `source-control:write` scope.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source control & issues, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source control & issues.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked items** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically,
and so does an agent creating one with `gh pr create` or `glab mr create`. Agents can link other
pull requests with the `link_pull_request` tool.

Agents can also read, open, update, reply on, and merge pull requests in the thread's repository
through iglo.code's own tools, which use the same sign-in as the Pull requests page. An agent merges
only the commit it last read: if someone pushed since, the merge is refused. On github.com an
agent can also land a GitHub stack in one merge, like **Merge stack** below.

Use **Link pull request to thread** in the command palette to keep a pull request with the thread. From a review
on the Pull requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked items** panel.
Linking and unlinking are available in the web app.

The **Linked items** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. Settling a thread refreshes its open and closed reviews once; after that they stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails or waits for a maintainer's approval, the required checks pass, the other checks finish after a failure, someone else comments or reviews, or the branch starts to
conflict. On github.com it also wakes the agent, with GitHub's reason, when the merge queue drops
the pull request without merging it. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. When the pull
request merges or closes, watching ends, and the agent is woken once unless it merged or closed the
pull request itself with the host's CLI. A reopened pull request needs a new watch. Watching also ends after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Watching a pull request again does not repeat check or conflict news its last
watch already reported; unlinking the pull request clears that. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked items** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working while the pull request still has checks running, so it stays in
the **Working** section, including after the agent pushes a fix. Once every check has finished,
including review bots that report as checks, the thread returns to your inbox: what happens next is
up to a person. That includes a workflow waiting for a maintainer to approve it, which runs only
once someone does. If you ask the agent to act on the pull request itself, such as merging it once
a teammate approves, the thread stays in **Working** until the pull request merges or closes. The
watch stays on and still wakes the agent on new comments, failed checks or conflicts, and a watched
thread never auto-settles.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## Issues

The Issues page lists the issues of every project whose remote is on GitHub, GitLab, Azure
DevOps or Forgejo, grouped per tracker account. Open it from the sidebar's utility row or with
**Open issues** in the command palette. Filter by open or closed, by your involvement
(assigned, opened by you, mentioning you), and by tracker. Under **Projects**, uncheck the
projects you do not want to see; the list remembers them, and a project you add later shows.
The search box asks the tracker itself where it can search. Press **Load more** at the end of a group to read further back.
The **Views** menu saves and restores a search, filter, and sort setup, as it does for pull
requests.

To list Linear issues beside a project's, connect Linear with an API key under
Settings → Source control & issues, then pick one or more teams for that project there. Pick
another team at any time to add it; uncheck every team to unbind the project. Each team's
issues appear in the Linear group of the issue list, sorted with the rest by last update, and
each can be loaded further on its own. Agents file new issues in the first team picked unless you name another bound team. To
connect another Linear workspace or user, add another account in the same place; each project
reads its teams through the account you picked them under.

Select an issue to open it beside the list: description, comments, state changes, linked pull
requests, labels, assignees, and reactions. Linked pull requests open in the same panel. You can
comment, edit the title and description, change labels and assignees, react, and move it to
another state when the tracker and your account allow it. Where a GitHub repository has issue
statuses (Backlog, Todo, In progress, and so on), those are the states you move between, as a
Linear team's workflow states are; elsewhere you close or reopen, with a close reason where the
tracker records one. An issue read through a project that does not own its repository is shown read-only.

An issue can be kept with a thread the way a pull request can: open it beside the thread (issue
links in the conversation open there) and use **Link to this thread** in its header; **Unlink**
undoes it. Click the issue badge in the thread sidebar to see its issues and pull requests in
**Linked items**. Select an issue there to open it beside the thread. Agents link the issues they
work on with the `link_issue` tool.

Writing to a tracker over a remote connection requires the `source-control:write` scope.

## GitHub stacks

The Pull requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
