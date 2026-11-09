# Updating iglo.code

iglo.code installs from GitHub Releases on `iglo-tech/iglo.code`. Each machine
follows a release channel: **stable** (the default) or **nightly**. A source
checkout is updated with `git pull` and a rebuild instead; see
[Run from source](./install.md#run-from-source).

## Update a machine

On the machine running iglo.code, run:

```sh
iglo.code update
```

It installs the newest release on the machine's channel. Pass an exact version,
such as `iglo.code update 1.2.3`, to move to that release. If a background
service is installed, the command asks before restarting it; pass `--yes` to
restart without asking, or decline and run `iglo.code service restart` when you
are ready. For a server you started by hand, stop it and start it again with
your usual options such as `--host` or `--tailscale-serve`.

If the fork has no matching archive for the machine, the update fails without
downloading upstream releases.

## Switch between stable and nightly

Pass `--channel` to move a machine to the other channel:

```sh
iglo.code update --channel nightly
```

The machine keeps following that channel for later updates. Moving back can
mean an older version: when stable is older than the nightly you run, use
`iglo.code update --channel stable --allow-downgrade`. Your threads, settings,
and data stay.

## Update from the web app

One web app can connect to several environments. When a connected server runs
an older release than the server hosting your web app, the update button at the
bottom of the sidebar and **Settings → Environments** offer to update it. The
sidebar button updates outdated providers first, then every server that is
behind. Hover it to see what it will update. A background service stays on its
current release channel.

| Action                  | What to do                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Update server**       | Keep the web app open while it installs and reconnects. Background services update remotely.                           |
| **Copy update command** | Stop the command-line server on the named host, run the copied command there, then restart it with your usual options. |

Each server checks that it can install the release before it restarts. If it
cannot, its update fails, the server keeps running, and you can retry. The
confirmation lists each machine it skips and why, such as a machine that is
offline or needs a manual update. The confirmation also counts the running
threads that the restarts will interrupt, and how many can resume afterwards.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
iglo.code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- A web app newer than the server is blocked before connecting, with a notice telling you to
  update iglo.code on the machine named in the notice.
- A server newer than your web app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## If an update fails

Keep the web app open until it reconnects or reports a failure. A failed service
update rolls back to the previous version. If the update still fails:

1. Retry once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version you want.

Only one server can use an iglo.code home directory at a time. If startup
reports that another server owns it, stop that server before retrying, or use a
separate home directory and pair with the running server.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. A provider is left out
when any of its enabled, outdated instances offers only a manual update command,
or when its instances use different update commands, such as two instances that
run different CLI installs. Update those by hand, or point every instance of the
provider at the same CLI.

After a successful provider CLI update, iglo.code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.
