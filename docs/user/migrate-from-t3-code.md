# Migrate from T3 Code

When you start iglo.code for the first time on a machine that already has T3
Code, it notices and offers to import automatically:

```text
Found a T3 Code installation at ~/.t3. Import its projects, threads and
settings into this empty iglo.code home? (Y/n)
```

Answer **Y** and iglo.code runs the import before starting. Answer **n** and it
starts fresh; the offer only appears while the iglo.code home is still empty,
so say yes the first time if you want your data. Pressing Ctrl+C at the prompt
quits without starting, and the offer appears again next time. The rest of
this page describes what that offer does. You can also run it by hand before
the first start, or from another T3 Code home:

```sh
iglo.code import
iglo.code import --from ~/other-t3-home
```

If the first start was not interactive — for example the background service
running "iglo.code serve", or a piped command — no prompt is possible; such a
start prints a one-line hint to run "iglo.code import" and skips creating a
project for the current directory, so the iglo.code home stays empty and
importable.

## Before you import

- **Stop T3 Code first, and disable its background service and
  launch-at-login entry**, so it cannot restart mid-import. The import refuses
  to run while the T3 Code server is running.
- **Stop iglo.code itself first** if it is already running from that home,
  including its background service — the import refuses while it runs, and
  following the hint printed by a headless start means stopping that server.
- The iglo.code home must be **clean**: no projects or threads from previous
  iglo.code use. A home that iglo.code already started in is still importable
  while it holds no projects or threads yet. Otherwise move the whole home
  aside (or pass `--base-dir` with a fresh directory) and import again — move
  the whole home, not just the database file, because leftover database
  sidecar files (`-wal`/`-shm`) corrupt a fresh import.
- Import supports current T3 Code releases. If your T3 Code is newer than your
  iglo.code build, update iglo.code first; the import tells you when it cannot
  recognize the source.
- The import needs free disk space for about two copies of the T3 Code database
  plus the rest of its home.

Nothing is written back to T3 Code: iglo.code never opens or modifies the old
database — it works from a private copy and snapshots that copy — so the old
home still works if you abandon the migration and go back. After the import
finishes, pair your browser and other devices again — T3 Code sessions and
pairing links do not carry over.

## What moves where

- **Threads and history** live in iglo.code's database. A thread that was
  waiting for a usage-limit reset keeps waiting and resumes on its own when the
  reset passes, exactly as if the server had restarted.
- **Thread worktrees** stay in the folder T3 Code created them in
  (`~/.t3/worktrees`). They keep working there and iglo.code manages them in
  place; do not delete `~/.t3` if you use them. Changing the worktrees location
  in settings only affects newly created worktrees — existing sandboxes keep
  running where they are.
- **"New project" repos** stay in `~/.t3/projects`; imported projects keep
  pointing at their original folders there, and new projects get fresh folders
  in the iglo.code home. Do not delete `~/.t3/projects` if you use them.
- **"No project" scratch folders** stay in `~/.t3/scratch`, which iglo.code
  links to from its own home, so imported "No project" threads keep their
  scratch identity. Do not delete `~/.t3/scratch` either.
- **Provider sessions** (Claude, Codex, and the rest) are untouched: providers
  keep their own session files on this machine, so imported threads continue
  the same conversations.
- **Checkpoints** are git refs inside each project's repository, so they keep
  working unchanged.
- **Environment identity** moves with the migration. Do not start T3 Code
  again from the old home after importing: two installs claiming the same
  identity can confuse a peer environment linked to either one.
