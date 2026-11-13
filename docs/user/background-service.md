# Running iglo.code in the background

On Linux and macOS, iglo.code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `iglo.code` command first ([Install iglo.code](./install.md#command-line)),
then run these commands on the machine that will host iglo.code:

| Task                                  | Command                       |
| ------------------------------------- | ----------------------------- |
| Set up access from your other devices | `iglo.code up`                |
| See how your other devices reach it   | `iglo.code status`            |
| Install and start                     | `iglo.code service install`   |
| Inspect status and log location       | `iglo.code service status`    |
| Move to a newer release               | `iglo.code update`            |
| Restart                               | `iglo.code service restart`   |
| Stop and remove from startup          | `iglo.code service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `iglo.code service install` again repairs a service that `iglo.code service status`
reports as broken.

`iglo.code update` downloads the newest release on your channel and switches `iglo.code`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `iglo.code service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating. See [Updating iglo.code](./updating.md).

Pass an exact version (`iglo.code update 0.0.42`) to pin one, `--channel nightly` to
switch channels, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test channel: its builds can be broken and are never offered as
updates, so the installer and `iglo.code update` ask for confirmation before
installing one.

`iglo.code uninstall` removes the background service, the `iglo.code` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.iglo.code/userdata` are kept, along with `service.env`
in the iglo.code home directory. Pass `--yes` from a script.

## Local network access

A new service answers only on this machine. Choose the local network in
`iglo.code up` (or run `iglo.code up --lan`, which sets `IGLO_CODE_LAN=true` in
`service.env`) to let other devices reach it. It then listens on your local
network and Tailscale addresses. It still does not answer on public addresses.
Anyone on the same network can reach the port, so a pairing code is all that
keeps them out. For other ways in, see [Remote access](./remote-access.md).

A service installed before `IGLO_CODE_LAN` existed keeps listening on the local
network. `iglo.code status` says so, and `iglo.code up --no-lan` turns it off. Any
`IGLO_CODE_HOST` value replaces this setting.

## Configure the service environment

Put custom environment variables in `service.env` in the service's iglo.code home
directory, normally `~/.iglo.code/service.env`. This file survives service installation
and updates. For example:

```dotenv
IGLO_CODE_PORT=4773
IGLO_CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `IGLO_CODE_HOME`,
`IGLO_CODE_BOOT_SERVICE_UNIT`, and `IGLO_CODE_SERVICE_LAUNCHER_CONTEXT` (including case variants).

Run `iglo.code service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `iglo.code service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default home, `chmod 600 ~/.iglo.code/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so iglo.code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

## Keep the server responsive when agents use all memory

On Linux, agents already run with lower priority than the server. When they
fill the machine's memory, though, the kernel may still slow down or stop the
server, because only an administrator can reserve memory for it. Run, as your
normal user:

```sh
iglo.code service protect
```

It shows the system settings it will change, asks before applying them, and
then asks for your sudo password. If the machine runs Tailscale or SSH, it
also offers to protect them, so you can still reach the machine. Memory
protection takes effect at once. The server's protection from the kernel's
out-of-memory killer takes effect after `iglo.code service restart`. `iglo.code service status` reports whether
the protection is in place, and `iglo.code service protect --undo` removes it.

## Troubleshooting

Start with `iglo.code service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running iglo.code as root creates a separate installation. Without administrator access, run `iglo.code serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status iglo.code.service`, then use the repair command printed by iglo.code.                |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `iglo.code service restart`.                     |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `iglo.code` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/code.iglo.service.plist`.

## Reclaim database space

iglo.code removes internal history older than a day on its own while it runs;
your conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. **Settings → Maintenance** suggests the repair
when at least 1 GiB can be reclaimed.

When the background service runs iglo.code on that machine, select **Reclaim**
in Settings. iglo.code checks for free disk
space, then stops, repairs the database, and starts again. It is offline while
the repair runs, and running agents stop. If the repair fails, Settings shows
why.

In other cases, such as a server you started by hand, run `iglo.code doctor` on the
machine that hosts the environment. It reports the database size and the
space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand first:
the repair refuses to touch a database that is in use, and names the server
process that holds it when it can tell. While the repair runs, a server started
for the same data directory is refused until the repair ends. Use `--base-dir` for a different data
directory.

The repair's time grows with the size of the whole database, not only the
space it reclaims, and can exceed an hour on a large database or a slow disk;
`iglo.code doctor` shows each step as it runs. It rebuilds the database through a
temporary copy, so it needs free space of about twice the data still in use
(the database size minus the reclaimable space): once in the system temporary
directory (on Linux and macOS, `TMPDIR`, or `/var/tmp` when it is not set) and
once next to the database for its write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `iglo.code doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings.
