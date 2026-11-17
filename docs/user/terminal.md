# Terminal

## Choose a shell

Set `IGLO_CODE_TERMINAL_SHELL` in the environment that launches the iglo.code server
to choose the executable used for new terminals. Use an executable name or its
full path, without surrounding quotes or command-line arguments. An unset or
blank value keeps the platform default. If the executable cannot be started,
iglo.code tries its usual fallback shells.

A shell export applies when you launch iglo.code from that shell; the background service reads
[`service.env`](./background-service.md#configure-the-service-environment). Restart iglo.code,
then create a new terminal.

This setting belongs to the machine hosting the server, including when you
connect from another device. It does not change provider-run commands or the
shell used by automatic project setup and settle scripts.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. iglo.code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when iglo.code restores saved terminal
history. A client can show less scrollback than the server keeps.

Use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

## fish

iglo.code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
iglo.code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches iglo.code. A shell export applies
when you launch iglo.code from that shell; it does not configure the background
service, which reads [`service.env`](./background-service.md#configure-the-service-environment). Enabling queries can restore the startup wait.
