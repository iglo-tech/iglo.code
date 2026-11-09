# FAQ

## What is iglo.code?

A personal fork of [T3 Code](https://t3.codes). It keeps only the server and
the web client that the server hosts; there is no native app, hosted web app, or
tunnel service. It uses its own command, home directory, and port, so it can run
next to an installed copy of the original. [Install](./install.md)

## Is iglo.code a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, runs
them, and hands the results back. Claude Code and Codex each pair an interface
with a harness underneath. iglo.code uses those harnesses; it does not work
without one.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google
Antigravity, Kiro, Pi, Muse Code, or fx. [Provider setup](./install.md#providers)

## Can I use it with my Claude Code subscription?

Yes. Providers use the CLIs and logins you already have.

## How much does it cost?

Nothing. It is open source (MIT). You still pay your provider as usual.

## Why is my Claude 5-hour limit draining so fast?

iglo.code drives Claude through Anthropic's Agent SDK, and Agent SDK usage drains
5-hour limits faster than using Claude Code directly. Weekly limits are not
affected. This is a known issue on Anthropic's side.

## How do I use it remotely?

Your agents run wherever iglo.code runs: a desktop, a server, a VPS. Run
`iglo.code up` on that machine to allow access from your local network and
tailnet, then pair your other devices. Tailscale HTTPS and SSH port forwarding
work too. [Remote access](./remote-access.md)

## How do I use it on my phone?

Open the web app in your phone's browser over your LAN or Tailscale, and pair
with a link from `iglo.code pair`. Add it to your home screen to use it like an
app. The phone is a remote: your computer does the work and needs to stay on.
[Remote access](./remote-access.md) · [Install the web app](./install.md#install-the-web-app)

## Can I add a bunch of accounts for one provider?

A separate work account is fine. Setup for two:
[Codex](./providers-codex.md#use-multiple-accounts) ·
[Claude](./providers-claude.md#separate-accounts-or-configurations). For a
bigger pool, manage them outside iglo.code with a self-hosted proxy like
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI); iglo.code can show
its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and
endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays
untouched. [OpenRouter](./providers-claude.md#openrouter) ·
[Provider instances](./install.md#providers)

## Does my code leave my machine?

Your code and prompts go from your machine to your provider (Anthropic, OpenAI,
and so on). iglo.code sends no product usage events unless you configure your
own endpoint. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup.
You can also run it now from there.
[Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. Choose an environment to transcribe on; the transcript goes into your draft
for review. [Voice input](./voice-input.md)

## Which systems are supported?

macOS (Apple silicon and Intel, macOS 13 or newer) and Linux (x64 and arm64).
Windows is not supported. Any device with a modern browser can connect.
[Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that
runs the server (not the device you browse from). Log in on that machine first,
like `codex login` or `claude auth login`. Still missing? Point **Binary path**
at it in provider settings. Version managers often cause this.
[Provider setup](./install.md#providers)
