# iglo.code

**A fast, self-hosted web interface for coding agents — built on [T3 Code](https://t3.codes) and refined for multi-machine, long-running workflows.**

Run your favorite coding agents on your Mac, Linux workstation, home server, or VPS, and drive them from any browser or phone over your local network, Tailscale, or SSH — with zero cloud relay, zero Node.js dependency, and sane defaults out of the box.

> **Unofficial fork notice:** iglo.code is an independent, unofficial fork of the open-source [T3 Code](https://github.com/pingdotgg/t3code) project and is not affiliated with, endorsed by, or maintained by T3 Tools, Inc. Almost all of the core engine, agent orchestration, git worktree workflow, diffs, checkpoints, remote sync, and UI foundation come directly from T3 Code. iglo.code tracks upstream closely so you keep getting T3 Code's improvements, while focusing on a lean self-hosted web experience and solving practical friction in daily use.

## What you get

Powered by T3 Code's architecture and bring-your-own-subscription model:

- **One workspace for all your agents.** Drive Claude Code, Codex, Cursor, OpenCode, Google Antigravity, Grok Build, Kiro, Pi, Muse Code, fx, and ACP registry agents using the CLIs and logins you already have — including multiple accounts or API-key instances side by side.
- **Isolated git worktrees, diffs & checkpoints.** Spin up parallel tasks without colliding in your working tree, inspect diffs and pull requests in place, and roll back cleanly with git checkpoints.
- **Work from any device.** Host the server where your code lives and open the installable web app from a laptop or phone over `localhost`, LAN, Tailscale HTTPS, or SSH.
- **Built-in Browser, Terminal & Device panels.** Preview live web apps, drop into terminals, and stream iOS Simulators or Android Emulators right beside your threads.
- **Schedules, webhooks & durable workflows.** Run recurring prompts, react to webhooks, or chain multi-step TypeScript workflows with human-in-the-loop approvals that survive server restarts.

## How iglo.code differs — and what it fixes

iglo.code keeps T3 Code's familiar feel while stripping away everything outside the self-hosted web experience and fixing pain points that show up when running agents across machines every day:

### Self-hosted web only, zero extra baggage

- **Just the server and the web client it hosts.** Upstream's native clients, hosted web client, cloud relay, account sign-in, and GitHub star popups are removed. Connect directly over your own network or Tailscale HTTPS and install the web app to your dock or home screen as a PWA.
- **Standalone Bun runtime.** The server and helpers run on Bun and ship as self-contained GitHub Release archives — no system Node.js, npm, or Bun required. Update from the CLI (`iglo.code update`) or straight from the web UI with checksum verification and automatic rollback.

### Multi-machine linking that actually stays connected

- **Two-way links in one step.** Linking two machines automatically links both directions with full access — no pairing twice, and **Forget** cleans up both sides together.
- **Your devices follow your links.** Pair your laptop or phone with one machine and it automatically connects to every machine that machine links to (and chains beyond), so your whole fleet shows up without re-pairing every device.
- **No silent 30-day disconnects.** Idle peer links check in daily to renew their sessions automatically instead of expiring whenever you haven't sent traffic across them for a month.

### A real Browser pane that doesn't trip over headless quirks

- **Headed full Chrome for Testing.** The Browser pane and visual HTML renders run full Chrome in headed mode instead of a stripped-down headless shell — avoiding sites, auth flows, and dev tools that break under headless browsers.
- **Headless Linux servers supported out of the box.** On Linux hosts without a display, iglo.code starts Xvfb on demand and cleans it up on exit. Run `iglo.code browser setup` once to install the required display, libraries, and AppArmor profile.

### A faster sidebar built for juggling many projects

- **Discord-style project rail.** A compact, color-tinted icon rail replaces the project filter dropdown — see unread completions, running work, and threads needing input at a glance, right-click for quick actions, and `Shift+click` to view multiple projects together without top-bar clutter.
- **Move threads between projects.** Started a conversation in the wrong repo? Move the thread to another project from its context menu (with undo, and its scheduled tasks moving along).
- **Scheduled tasks right in the sidebar.** A collapsible **Scheduled** section sits under **Working**, sorted soonest first, and opens each task's editor inline instead of hiding it behind Settings dialogs.

### Fewer stalled threads and runaway background jobs

- **Auto-resume after usage limits.** Threads paused by a provider rate limit automatically continue as soon as the limit window resets — enabled by default.
- **Auto-stop idle background commands.** Dev servers and watchers that agents forget to shut down are stopped automatically after a configurable idle period (pinned threads and active waits stay exempt), with a one-click **Turn it back on** action right in the chat.
- **Smarter recurring automations.** Thread-bound recurring checks keep a single outstanding check when a thread is busy or rate-limited instead of piling up duplicate queued prompts, while keeping explicit **Run now** requests separate and showing truthful queued/dispatched status.

### Ready-to-go defaults & everyday polish

- **Sensible defaults from day one.** Worktree mode, automatic pull, automatic cleanup of merged/stale worktrees, review guides, workflows, linked environments, and prompt suggestions are turned on out of the box (and remain configurable in Settings).
- **Quality-of-life extras.** Fresh workspace-scoped skill discovery in the composer, optional history-swipe navigation (off by default so accidental trackpad swipes don't kick you out of a thread), and Mistral Vibe session stats and cost tracking in the Usage view.

## Side by side with T3 Code (and easy migration)

iglo.code is completely isolated from an existing T3 Code installation: it uses its own `iglo.code` command, `~/.iglo.code` home directory, `iglo.code.json` project file, and default port `4773`. You can run both on the same machine without conflicts.

Already using T3 Code and want to bring your history over? On first interactive launch, iglo.code detects your existing setup and offers to import your projects, threads, and settings automatically — or you can run `iglo.code import` anytime against a clean iglo.code home. The importer works from a private copy and never modifies T3 Code's database, so you can always switch back safely. See [Migrate from T3 Code](./docs/user/migrate-from-t3-code.md).

## Quick start

Install the latest release (macOS Apple Silicon and Linux x64 prebuilt archives; macOS Intel and Linux arm64 can be [built from source](./docs/user/install.md#run-from-source); Windows is not supported):

```bash
curl -fsSL https://raw.githubusercontent.com/iglo-tech/iglo.code/main/scripts/install.sh | sh
```

Common commands:

| Goal                                      | Command                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Start the server and open the web app     | `iglo.code`                                                                 |
| Enable LAN / Tailscale access as a daemon | `iglo.code up` ([Remote access](./docs/user/remote-access.md))              |
| Pair another browser or phone             | `iglo.code pair`                                                            |
| Set up full Chrome + Xvfb on Linux        | `iglo.code browser setup`                                                   |
| Import projects & threads from T3 Code    | `iglo.code import` ([Migration guide](./docs/user/migrate-from-t3-code.md)) |
| Update to the latest release              | `iglo.code update` ([Updating](./docs/user/updating.md))                    |

After starting, open **Settings → Providers** to enable any agent CLI installed on the host machine. Any device with a modern browser can connect — see [Install the web app](./docs/user/install.md#install-the-web-app) for adding it to your dock or home screen.

## Documentation

- [Install & provider setup](./docs/user/install.md) · [Migrate from T3 Code](./docs/user/migrate-from-t3-code.md) · [FAQ](./docs/user/faq.md)
- [Remote access & linked environments](./docs/user/remote-access.md) · [Background service](./docs/user/background-service.md) · [Ubuntu LTS + XFS host blueprint](https://gist.github.com/Igloczek/22656407adee128dce65c60eb0820fa2)
- [Threads & sidebar](./docs/user/thread-sidebar.md) · [Workflows](./docs/user/workflows.md) · [All user guides](./docs/README.md)
- [Local setup and development](./docs/operations/00_development.md) · [Syncing with upstream](./.agents/skills/sync-upstream/SKILL.md)

## Credit & License

Huge thanks to the [T3 Code](https://t3.codes) team and contributors at [pingdotgg/t3code](https://github.com/pingdotgg/t3code) for building and open-sourcing the remarkable foundation this fork stands on.

Source code is licensed under the [MIT License](./LICENSE). T3 Code's trademarks and branding belong to T3 Tools, Inc.; see [TRADEMARK.md](./TRADEMARK.md).
