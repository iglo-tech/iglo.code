# CLI reference (`iglo.code`)

The `iglo.code` command runs and manages iglo.code servers, the background service, remote access, threads, workflows, and diagnostics. Run `iglo.code --help` or `iglo.code <command> --help` for full flags.

See [Install iglo.code](./install.md#command-line) for installation.

## Running and connecting

| Command                                | Description                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `iglo.code [path]` / `iglo.code start` | Start a foreground server and open the web app (optionally in a project directory).                                 |
| `iglo.code serve`                      | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`).        |
| `iglo.code up`                         | Interactive setup for remote access (LAN and Tailscale) plus the background service (`--lan`, `--no-lan`, `--yes`). |
| `iglo.code status`                     | Show how other devices can reach this host (`--json`).                                                              |
| `iglo.code pair`                       | Generate a one-time pairing URL and QR code (`--tailscale`, `--scope <scope>`).                                     |

## Background service and updates

| Command                                     | Description                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iglo.code service`                         | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `iglo.code update [version]`                | Update `iglo.code` and the service (`--channel nightly`, `--allow-downgrade`, `--yes`).                                                             |
| `iglo.code install` / `iglo.code uninstall` | Install or remove the `iglo.code` launcher and background service (keeps `~/.iglo.code/userdata`).                                                  |
| `iglo.code import`                          | One-time import of an installed upstream home into a clean iglo.code home. See [Migrate from the original app](./migrate-from-t3-code.md).          |

## Threads, projects, and workflows

| Command              | Description                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iglo.code thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Scripts on the host](./outside-agents.md#scripts-on-the-host). |
| `iglo.code project`  | Manage projects on the host (`add`, `remove`, `rename`).                                                                                                                                                          |
| `iglo.code workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                            |

## Environments, auth, themes, and policy

| Command                 | Description                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `iglo.code environment` | Link or manage peer environments (`link`, `list`, `unlink`). See [Link another environment](./remote-access.md#link-another-environment). |
| `iglo.code auth`        | Manage pairing codes and sessions (`pairing create/list/revoke`, `session issue/list/revoke`).                                            |
| `iglo.code theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                       |
| `iglo.code policy`      | Validate, inspect, and generate MDM templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`).     |

## Diagnostics and maintenance

| Command                   | Description                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `iglo.code doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                       |
| `iglo.code browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser.   |
| `iglo.code trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                             |
| `iglo.code triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the iglo.code triage playbook.             |
| `iglo.code feedback`      | Send or inspect agent feedback reports (`list [--json]`, `--kind`, `--subject`, `--expected`, `--actual`). |
