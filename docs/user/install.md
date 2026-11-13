# Install iglo.code

iglo.code runs coding agents on your computer and lets you control them from a
web app that the same server hosts. It is a [fork](./faq.md#what-is-iglocode) that installs
side by side with the original: its own `iglo.code` command, `~/.iglo.code` home directory, and
default port 4773. Set up the machine where the agents will work first.

## Requirements

Supported targets are macOS arm64, macOS x64 (Intel, macOS 13 or newer), Linux
x64, and Linux arm64. Windows is not supported. Release archives include the Bun
runtime for the server and its helpers; Node.js and npm are not required.
Provider CLIs keep their own prerequisites.

You need an installed, authenticated provider before starting a thread. You can
launch iglo.code and configure providers afterwards.

## Command line

No release has been published yet. Until the first one, [run from
source](#run-from-source). Once releases exist, install with:

```bash
curl -fsSL https://raw.githubusercontent.com/iglo-tech/iglo.code/main/scripts/install.sh | sh
```

This installs the `iglo.code` command to `~/.local/bin`. If that folder is not
on your `PATH` yet, the installer says so and, for zsh, bash on Linux, and fish,
prints a command to add it. If an `iglo.code` that the installer did not create
is already there, it leaves that one alone and stops. Set
`IGLO_CODE_CHANNEL=nightly` to install the nightly channel, or
`IGLO_CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Start the server and open the web app            | `iglo.code`                                                                    |
| Start the server without a browser               | `iglo.code serve`                                                              |
| Use it from your other devices                   | `iglo.code up` ([details](./remote-access.md))                                 |
| Keep it running in the background (macOS, Linux) | `iglo.code service install` ([details](./background-service.md))               |
| Move to the newest release                       | `iglo.code update` ([details](./updating.md))                                  |
| Reclaim database space                           | `iglo.code doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                                  | `iglo.code uninstall`                                                          |

Run `iglo.code help` or `iglo.code --help` for the full reference. To start in a
new working directory, use an explicit path such as `iglo.code ./my-project`. A
bare directory name is accepted only if it already exists.

If `iglo.code` or `iglo.code start` reports an already running server, connect
to that server instead. Stop it before starting a replacement, or use a
different `--base-dir` for an independent server.

### Install the web app

The web app can be installed as a standalone app window or home screen icon. In
Chrome or Edge, use **Install** in the address bar or the browser menu. In
Safari, use **File > Add to Dock** on macOS, or **Share > Add to Home Screen** on
iOS.

Browsers offer installation only over HTTPS or on `localhost`. To install on
another device, connect through [Tailscale HTTPS](./remote-access.md#tailscale-https)
rather than a plain HTTP LAN address.

### Run from source

Install the Bun version named in the repository's `.bun-version` file and
Vite+ for the contributor toolchain, then run:

```bash
git clone https://github.com/iglo-tech/iglo.code.git
cd iglo.code
vp i
vp run --filter t3 build
bun apps/server/src/bin.ts serve
```

Add `--base-dir <dir>` to keep this server's data apart from an installed
iglo.code, and `--no-browser` to skip opening the web app. For the development
web client, use `vp run dev` and open its printed pairing URL. Vite+ and pnpm may
use Node internally; that is separate from the Bun application runtime. See
[Development](../operations/development.md) for setup.

Source runs are updated with `git pull` and a rebuild; installed archives use
`iglo.code update`.

## Providers

Open **Settings → Providers** in the web app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from iglo.code's provider settings.                                                                                       |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If iglo.code cannot find one, set
its **Binary path** in provider settings, especially when using a version
manager. Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

iglo.code warns when a provider version has known compatibility problems with
your release. Check **Settings → Providers** on that environment for the
recommended version or range. When its package manager supports installing a
specific version, you can install the recommendation there. Otherwise use the
provider's installer on the environment's machine. An unlisted version is
unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when iglo.code cannot tell. Claude, Codex, and
OpenCode installs iglo.code cannot identify stay manual: update them through the
installer you used. iglo.code runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with iglo.code. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release iglo.code tested. When iglo.code finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, iglo.code does not
display their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but iglo.code reports a timeout while checking it,
allow more time in the iglo.code server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
IGLO_CODE_CODEX_PROBE_TIMEOUT_MS=60000 IGLO_CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 iglo.code serve
```

For a remote environment, set these on the machine running the iglo.code server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=IGLO_CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                      |
| ------------------- | ----------------------------------------- |
| Codex               | `IGLO_CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `IGLO_CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `IGLO_CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `IGLO_CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `IGLO_CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `IGLO_CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `IGLO_CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `IGLO_CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `IGLO_CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `IGLO_CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `IGLO_CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating iglo.code](./updating.md): update the server and its providers.
- [Managed policy](./managed-policy.md): configure iglo.code for everyone on a machine.
