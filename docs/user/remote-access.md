# Remote access

Use iglo.code from a phone or another computer while it runs on a different
machine. That machine must stay running and reachable while you work. Other
devices reach it over your local network, Tailscale, or an SSH port forward;
the web app is served by the iglo.code server itself.

## Set up access

On the host, run:

```bash
iglo.code up
```

It asks whether other devices on your local network may connect. On Linux and
macOS, it then runs iglo.code as a [background service](./background-service.md).
Run `iglo.code up` again to change your choice, and `iglo.code status` to see it.

`iglo.code up --lan` and `iglo.code up --no-lan` ask nothing, and `--yes` keeps
the current settings. Without a terminal, a needed restart runs without asking
and stops running agent turns. `iglo.code status --json` prints the settings for
scripts. For a server in a terminal, run `iglo.code serve --lan` instead.

With network access on, iglo.code accepts connections from your local network
and tailnet, so a pairing code is all that keeps other devices on them out. It
does not answer on public addresses.

## Pair a device

If a server is already running, generate a fresh link without restarting it:

```bash
iglo.code pair
```

Scan the QR code on your phone, or paste the pairing URL into a browser that can
reach the host or into **Add environment** in another iglo.code web app.
Connection settings are under **Settings → Environments**. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Sharing & access page stays open. If you leave or reload that page, create
another link to share.

Browsers block plain HTTP addresses from HTTPS pages and only install the web
app over HTTPS or on `localhost`, so prefer [Tailscale HTTPS](#tailscale-https)
when you need either.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, or an SSH forward. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list. A pairing link for a saved machine is
refused when it comes from an address that machine does not have yet; add that
address with **Add route** instead. Pairing again over an address the machine
already has still works. A new route is placed by speed, in that order, and you
can reorder routes at any time.

While connected through a paired address, iglo.code also learns the machine's
current LAN and Tailscale addresses and adds them as routes. When the machine's
LAN address changes, for example after it joins another Wi-Fi network, the
learned route follows it. The machine must allow network access for its LAN
address to be learned: the
[local network](./background-service.md#local-network-access) choice in
`iglo.code up`. You can reorder a learned route, but not remove it; it goes away
with the route it was learned through, or when the machine stops reporting that
address.

iglo.code connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, iglo.code checks the earlier ones when your network changes, when
you return to the app, and every minute, and moves back as soon as one works.

Select the route count under the machine's name in
**Settings → Environments** to see its routes. Drag a route to change the order,
or remove it.

Open **Permissions** next to **Routes** to see what your current connection can
do on that environment. For a remote environment, this is in its route details.
Permissions shown there apply only to the route marked **In use**; other routes
are not checked.

### Balance new threads across machines

Auto balance is off by default. Enable it in
**Settings → Environments → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.

### Tailscale HTTPS

Join both devices to the same tailnet. To start a server with Tailscale HTTPS:

```bash
iglo.code serve --tailscale-serve
```

For an already-running server:

```bash
iglo.code pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 --set-path=/ off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `iglo.code pair --help` for other pairing options.

### SSH

When you can reach the host only over SSH, forward its port to your device:

```bash
ssh -L 4773:localhost:4773 your-server
```

Use the port the server reports if it is not 4773. Run `iglo.code pair` on the
host, then open its pairing link on your device with the address replaced by
`localhost:4773`. The forward must stay open while you work. The server sees
the connection as coming from its own machine, so it works without network
access turned on.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The web client streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the iglo.code home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Local servers

The browser lists ports held by processes your terminals and agents started.
iglo.code reads which process holds each port and never connects to it, so a
listed port opens as `http://localhost:<port>` and might not be a web page. For
an HTTPS server or a specific path, set the **Preview URL** on the project
script that starts it; iglo.code checks that address and opens it as written.

To stop listing ports, set `IGLO_CODE_PORT_DISCOVERY=0` in the environment that
starts the iglo.code server, such as
[`service.env`](./background-service.md#configure-the-service-environment) for
the background service, and restart it. Script preview URLs still appear.

### Browser host setup

macOS and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo iglo.code browser setup
```

The server shows the exact line for how you started it, such as
`sudo iglo.code browser setup`, and keeps your `PATH` when Bun or iglo.code is
installed only for your user. Where `iglo.code` is not on your `PATH`, a standalone install names its
full executable path. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

The browser runs in Chrome's sandbox by default. Chrome cannot start that sandbox
as root. If your iglo.code server runs as root, run it as a nonroot user to keep
sandboxing enabled. `iglo.code browser setup` does not fix this root restriction.

If you need to run as root, or cannot enable the sandbox on your host, set
`IGLO_CODE_SERVER_BROWSER_SANDBOX=0` in the **iglo.code server's environment** and restart
the server. This disables Chrome's sandbox. For a manual launch:

```sh
IGLO_CODE_SERVER_BROWSER_SANDBOX=0 iglo.code serve
```

For a systemd service, add `IGLO_CODE_SERVER_BROWSER_SANDBOX=0` to
[`service.env`](./background-service.md#configure-the-service-environment) and
run `iglo.code service restart`. Setting the variable in an agent's terminal does not change the
environment of an already running server.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents iglo.code did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Link another environment

Link two machines, such as your laptop and a VPS, and agents on one can work on
the other: launch, message, wait on and stop its threads, answer their
questions, and manage its queues, projects and scheduled tasks.

Linked environments is a beta. Turn it on for both machines in **Settings →
Labs**. While it is
off on either machine, agents start nothing over a link between them. A task
already running on the other machine still finishes, and if that machine has it
off, its result arrives once it is back on.

On the machine you will work from, open **Settings → Environments → Linked environments**,
choose **Link**, and pick the other machine or enter its address. The list
holds the machines this app knows. If this
app is connected to that machine with a session that manages access there, it
makes the pairing code itself; otherwise paste one from that machine's
**Settings → Sharing & access**. From a terminal, use
`iglo.code environment link <address> --pairing-code <code> --access <mode>`.

You can also ask an agent to link a machine by name, such as "delegate this to
my vps". It shows a card in the thread where you pick the machine the same way
and the access, then approve. An address the agent gives that this app does
not know for one of your machines also needs a pasted code. Paste one only for
an address you trust: the code is sent there.

- The access you pick is the most agents from this machine may do there. An
  agent also never gets more there than its own mode here.
- Threads a link starts are marked **From** and this machine's name there.
- A full-access link works there like that machine's own agents. Below full
  access, the link's agents can change only threads it started, not that
  machine's own threads, projects or settings, and they skip its project setup
  scripts.
- The link shows up in that machine's **Settings → Sharing & access** like any
  outside agent. Revoke it there to end it. **Forget** on this machine only
  removes it here.
- Links last 30 days. Link again with a new pairing code to renew one.

An agent can also hand a task to a linked machine with `delegate_task`: it runs
there as an ordinary thread, in the project with the same repository (or the
one `target.projectId` names), and this thread wakes with its result when it
ends, as for any delegated task. It keeps following the task across restarts.
If the other machine revokes the link, or the link is removed here, the task
fails with that reason.

## Manage or revoke access

On the host, **Settings → Sharing & access** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `iglo.code auth --help`.

When the app connects to more than one environment, choose one at the top of the
page.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
iglo.code pair --scope orchestration:read --scope terminal:read
```

The selected scopes replace the default permissions. The same option works with
`iglo.code auth pairing create` and `iglo.code auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For a saved remote environment in the web client, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, environment maintenance, and access
management can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.
