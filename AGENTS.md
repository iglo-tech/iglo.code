# iglo.code

## Fork scope

iglo.code is a personal fork of T3 Code that ships only the server and the web client the server hosts. The desktop and native mobile apps, the marketing site, the npm package, and the devcontainer are intentionally removed. It installs as the `iglo.code` command with its own home (`~/.iglo.code`), `IGLO_CODE_*` variables, and default port 4773, so it runs side by side with an installed T3 Code. Apply [sync-upstream](.agents/skills/sync-upstream/SKILL.md) when importing upstream changes to preserve this scope and naming. Shared runtime, server compatibility, remote access, and the Device panel remain supported. T3 Connect (upstream's relay, Clerk sign-in, and hosted app) is disabled: `hasCloudPublicConfig` is hard-coded false in the server and web `cloud/publicConfig.ts`, and `infra/relay` is removed.

T3 Code is a minimal GUI for coding agents. A WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, fx, and others) and serves the web client.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks (our MIT license covers source code only, not T3 Code's trademarks or branding; see [TRADEMARK.md](TRADEMARK.md)). We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of the websocket layer enables a lot of awesome remote features. These have become core to the product. In this fork users connect over their local network, Tailscale (including Tailscale HTTPS), or SSH, and new features need to work on each.

### 4. One web surface

This fork ships one surface: the **web** client, served by the user's own server (`iglo.code`) to local and remote browsers. There is no hosted app. A browser may also connect to more than one environment.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most contributions will come from iglo.code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the iglo.code instance that the contributor is using.

## Terminology

- **you** = the agent reading this file. **we / us / maintainers** = the iglo.code maintainer you are talking to (upstream T3 Code is built by Theo, Julius and their team; their principles above still apply). **user** = person driving coding agents in iglo.code. **agent** = coding agent running inside iglo.code.
- Domain terms (environment, project, thread, turn, provider, checkpoint, etc.): [00_glossary.md](docs/internals/00_glossary.md).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.iglo.code/userdata` is the developer's real iglo.code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Client.** The web client served by the server, in desktop-width and phone-width browsers. Shared logic lives in `packages/client-runtime`.
- **Providers.** Each built-in driver in `apps/server/src/provider/builtInDrivers.ts` (Codex, Claude, Cursor, Grok, Fx, OpenCode, Antigravity, Kiro, Pi, Muse, and ACP registry agents) has an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server and web client follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, LAN, Tailscale, and SSH behave differently. Multi-device and multi-environment cases are real.
- **Languages.** User-facing text ships in every locale: translate new keys in `apps/web/src/i18n/translations` after `vp run i18n:generate` (`vp run i18n:check` gates it). See [14_i18n.md](docs/internals/14_i18n.md).
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers and test data

See [00_development.md](docs/operations/00_development.md) for setup, state and ports, and [reusable dev auth](docs/operations/00_development.md#reusable-dev-credential). Agent-specific rules:

- **Worktree setup:** `vp i` runs from the iglo.code.json setup script, in the background. While `.iglo.code/setup-running` names a live PID, wait for it and do not run `vp i`. It ends with `.iglo.code/setup-done` or `.iglo.code/setup-failed` (with the error tail). With no marker at all, setup never ran here, so run `vp i` yourself.
- **State and ports:** `vp run dev` in a worktree defaults to that worktree's gitignored `.iglo.code`, which deliberately outranks an ambient `IGLO_CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins. A plain `git clone` is not a worktree: it shares `~/.iglo.code/dev` with the main checkout and is not seeded (isolate it with `vp run migrate-dev-db --base-dir <clone>/.iglo.code`, then `vp run dev --home-dir <clone>/.iglo.code`). Read the real ports from the `[dev-runner]` line; occupied ports shift.
- **Process lifecycle:** Start dev servers and builds from your own shell so they exit with your session. Never detach them with `systemd-run`, `nohup`, `setsid`, or `tmux` unless the user asks for one that outlives the session; detached servers ran for weeks and filled RAM and swap. Stop what you started by the PID you tracked (rule 1). `vp` does not forward SIGTERM to Vite and the server, so stop the background task with your harness's own stop. The dev runner stops itself above `--memory-limit-gb` (half of RAM, at most 16 GiB) on Linux.
- **Sharing (`vp run dev --share`):** Run it in the background, wait for the `pairingUrl:` line, and hand the full URL to an unpaired browser. Never wire `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a one-time token was consumed, mint another with `node apps/server/src/bin.ts pair` (standard scopes; the startup URL carries the admin scopes Connections settings needs).
- **Reusable dev auth:** Configure one fixed `IGLO_CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`; the `iglo.code.json` setup links it into worktrees. Never commit or publish the token or a startup URL.
- **Test data:** An empty database is a bad test. The first `vp run dev` in a worktree seeds it from a read-only snapshot of `~/.iglo.code/userdata/statev2.sqlite` when the source is at most 500 MiB (`--no-seed` or `IGLO_CODE_DEV_SEED=0` skips). With dev stopped, `vp run migrate-dev-db` rebuilds `<worktree>/.iglo.code/userdata/statev2.sqlite` from that snapshot, keeping recent projects and their stopped threads and dropping scheduled tasks, pending work, auth sessions, and links to other environments, so your server never runs the developer's agents or reaches their other machines (raise `--projects` and `--threads-per-project` for more). Refresh `statev2.sqlite`, not `state.sqlite`. Bring `secrets` and `settings.json` only if the flow under test needs them. Copy in, never symlink; data never flows back out.
- **Extra checkouts:** Put `git worktree add` next to this worktree, not in `/tmp`, and remove it when done.

## Verifying

- Before you push, run `vp run check:changed`. This fork has no CI, so also run the [pre-push checks](docs/operations/00_development.md#pre-push-checks) before pushing to `main`. **Do not run repo-wide checks** (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless I ask; use focused tests for the behavior you change.
- Iterate with `vp test run <files>` (add `-t "<name>"` for large files) and `vp run typecheck` (`effect-tsgo tsrs --noEmit`; there is no `typescript` package). Run `node -e` snippets from the owning package (`effect` does not resolve from repo root).
- Follow [15_testing.md](docs/internals/15_testing.md) for what to test, bug-fix proof, draining async work (no sleeps/polling), and web browser tests (`await using screen = await render(...)`). Backend behavior changes ship with focused tests for that behavior.
- Upon request, user-visible frontend changes get one integrated pass in a real client with `test-t3-app` (primary agent only; subagents do not launch dev servers). Ask permission before computer use or spinning up browsers. Use the free `Replay (dev)` provider that `vp run dev` registers ([test-t3-app](.agents/skills/test-t3-app/SKILL.md)) unless the change depends on a real provider, then pick its cheapest model (Haiku for Claude, Luna for Codex).

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before changing that text, read [evals/README.md](evals/README.md) and run the evals it names. When fixing a model behavior bug, add a case that fails before the fix.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images; motion or timing needs a short video. Upload PR evidence to GitHub—never commit PR-only screenshots or assets.
- One request is one PR. Split only when asked. Outside contributions follow [CONTRIBUTING.md](CONTRIBUTING.md#one-problem).
- When babysitting: call `watch_pull_request` and end your turn. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new; stop when bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields, methods, constants, timeouts, or migration numbers, narrate control flow, maintain file catalogs, or append PR summaries. Anything that can drift will drift; types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks in the shipped product's voice, without implementation details or contributor tooling. Focus on what a feature does, how to start, and anything unintuitive—not descriptions of buttons, layouts, or UI tweaks.
- `docs/operations/` holds maintainer setup, release, and debugging runbooks. Keep end-user server instructions in `docs/user/`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files (keep temporary material outside the worktree).
- Track active maintainer work in its GitHub issue or project item; external proposals belong in Ideas discussions. A merged PR is the implementation record.

## Where code lives

- `apps/server` - WebSocket, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing. Read [02_effect-services.md](docs/internals/02_effect-services.md) and `.repos/effect/LLMS.md`.
- `apps/web` - React/Vite UI served by the server.
- `packages/contracts` - Effect/Schema wire contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client connection and domain state shared across the web client.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them (`vpr sync:repos` updates them; if sparse-checked-out, read via `git show origin/main:.repos/<path>`).

### Internal docs by area

Read the matching doc before changing code in that area; code review enforces them.

| Area                                       | Read first                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Architecture & orchestration               | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md) |
| Server Effect services & errors            | [02_effect-services.md](docs/internals/02_effect-services.md)                                            |
| Providers & ACP                            | [03_providers.md](docs/internals/03_providers.md)                                                        |
| Auth, MCP, assets, security                | [04_environment-auth.md](docs/internals/04_environment-auth.md), [SECURITY.md](SECURITY.md)              |
| Remote routes, peer links                  | [05_remote.md](docs/internals/05_remote.md)                                                              |
| T3 Connect & relay (disabled in this fork) | [06_t3-connect.md](docs/internals/06_t3-connect.md)                                                      |
| Server updates & crash recovery            | [07_server-updates.md](docs/internals/07_server-updates.md)                                              |
| Telemetry & analytics                      | [08_product-analytics.md](docs/internals/08_product-analytics.md)                                        |
| Client connection & sync runtime           | [09_connection-runtime.md](docs/internals/09_connection-runtime.md)                                      |
| Web UI primitives, styles & React Compiler | [10_web-ui.md](docs/internals/10_web-ui.md)                                                              |
| Translations & UI copy                     | [14_i18n.md](docs/internals/14_i18n.md)                                                                  |
| Writing & reviewing tests                  | [15_testing.md](docs/internals/15_testing.md)                                                            |
| Wire budgets & perf                        | [16_performance-regressions.md](docs/internals/16_performance-regressions.md)                            |
| Repo & package scripts                     | [17_scripts.md](docs/internals/17_scripts.md)                                                            |
| Bun runtime and platform adapters          | [bun-runtime.md](docs/internals/bun-runtime.md)                                                          |

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`, declare protected methods in `CLIENT_GUARDED_RPC_SCOPES`, and gate UI with `permissionAtom` (server stays authoritative). Keep raw RPC clients inside `rpc/`.
- Server features are Effect services using `Effect.fn("Service.operation")` with thin transport handlers; see [02_effect-services.md](docs/internals/02_effect-services.md).
- `apps/web/src/components/ui` exports own their look (`shadcn/no-restyle` enforces this); see [10_web-ui.md](docs/internals/10_web-ui.md).
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, external quirk, or invariant the code can't show (1–4 lines max; `t3code/no-low-value-comments` enforces this).
- React effects are only for synchronizing with external systems. Derive in render and act in handlers; any remaining effect states its reason via `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- Security matters, but do not over-index on dev-mode or maintainer-only features. Read [SECURITY.md](SECURITY.md) before auditing or triaging reports.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
