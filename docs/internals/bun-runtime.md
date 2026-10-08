# Bun runtime boundaries

The fork runs its application server and helpers on Bun, while retaining Effect
services and working Node-compatible APIs. The migration changed the runtime and
packaging first, replacing APIs where compatibility failed. Native Bun APIs remain
possible improvements at the adapter boundaries below; their performance benefit
has not been established for this application.

Keep domain services, typed errors, scoped resource cleanup, and the event-sourced
orchestrator independent of the platform implementation. An adapter change must
preserve those behaviors rather than spread direct Bun calls through features.
Vite+/pnpm and their Node contributor toolchain are a separate concern.

## Remaining native API candidates

| Boundary                                                                                                                                                               | Native option                                                                                           | Why the current boundary remains / what a replacement must preserve                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP and WebSocket serving in [server.ts](../../apps/server/src/server.ts)                                                                                             | [`Bun.serve`](https://bun.sh/docs/runtime/http/server), preferably through Effect's Bun HTTP adapter    | The existing Effect Node HTTP server composes routing, authentication, RPC, OAuth, MCP, streaming, and graceful shutdown. [Browser streams](../../apps/server/src/preview/ServerBrowserStream.ts) also depend on Node request/socket access for compression control and bounded buffering. A native adapter needs equivalent upgrades, backpressure, disconnect cleanup, and local/remote/relay behavior; changing the server layer alone is insufficient. |
| SQLite behind [nodeSqliteClient.ts](../../packages/shared/src/nodeSqliteClient.ts)                                                                                     | [`bun:sqlite`](https://bun.sh/docs/runtime/sqlite), with an Effect SQL adapter                          | The current `node:sqlite` implementation preserves the shared `SqlClient` contract. Replacement must retain transaction/savepoint behavior, writer locking, WAL/foreign-key settings, typed SQLite errors, safe integers, and boolean/result-mode normalization. Core events, projections, receipts, and outbox effects must still commit atomically; plugin databases retain their separate transactions.                                                 |
| Subprocess spawning behind `ChildProcessSpawner`, [shell.ts](../../packages/shared/src/shell.ts), and [the service launcher](../../apps/server/src/serviceLauncher.ts) | [`Bun.spawn` / `Bun.spawnSync`](https://bun.sh/docs/runtime/child-process) behind the existing services | Provider protocols, Git, helpers, and service lifecycle rely on streaming stdin/stdout/stderr, output bounds, cancellation, process exit and signal semantics, environment/PATH resolution, and IPC. The compiled CLI's self-invocation differs from source scripts. Preserve update handoff and rollback as well as ordinary spawning. PTYs already have their own native Bun adapter.                                                                    |
| File I/O and HTTP file responses in [http.ts](../../apps/server/src/http.ts)                                                                                           | [`Bun.file` / `Bun.write`](https://bun.sh/docs/runtime/file-io), scoped behind Effect services          | Select measured file-serving or read/write paths rather than replacing all filesystem calls. [Media files](../../apps/server/src/assets/MediaFile.ts) and static responses hold validated descriptors; reopening a path loses that guarantee. Preserve non-blocking/no-follow opens, file identity, range/HEAD handling, cache/compression semantics, and closure on cancellation.                                                                         |

Effect's read-only reference under `.repos/effect-smol` contains `BunHttpServer` and a
`sql-sqlite-bun` adapter; inspect them before inventing equivalents. Check their
implementation and compatibility against the dependency version being adopted.
In the Effect 4.0.1 reference, `packages/platform/bun/src/BunFileSystem.ts` uses
the shared Node filesystem implementation, and its sibling
`BunChildProcessSpawner.ts` re-exports the shared Node spawner. Switching to
`BunServices` alone therefore does not migrate those operations to `Bun.file` or
`Bun.spawn`.

## Diagnostics and APIs already backed by Bun

`node:` imports execute inside Bun; their presence does not mean a Node process
is running. Keep working compatibility APIs unless a native alternative fixes a
demonstrated incompatibility or improves an observed cost.

- [BunPtyAdapter](../../apps/server/src/terminal/BunPtyAdapter.ts) already uses
  Bun's terminal/subprocess API because the inherited PTY implementation failed
  under Bun. The source and compiled CLI use that adapter.
- Executable bundles deliberately leave `ws` external to use Bun's compatibility
  module. Inlining npm's implementation bypasses Bun's HTTP-upgrade bookkeeping
  and can corrupt Browser WebSocket frames. Keep the shared
  [bundling/staging boundary](../../scripts/lib/cli-external-packages.ts).
- [HeapSnapshot](../../apps/server/src/observability/HeapSnapshot.ts) still calls
  `node:v8.writeHeapSnapshot`, but [Bun 1.4.2 implements it](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/js/node/v8.ts#L349-L367)
  through `Bun.generateHeapSnapshot("v8")`. The file contains JavaScriptCore heap
  data in V8-compatible format. Renaming this call would not introduce a new
  snapshot engine. Native [`bun:jsc` heap statistics](https://bun.sh/docs/project/benchmarking#javascript-heap-stats)
  are a possible addition for diagnostic detail, distinct from OS memory usage.
- [EventLoopMonitor](../../apps/server/src/observability/EventLoopMonitor.ts)
  already accounts for Bun histogram lateness and macOS sleep. Bun 1.4.2's
  utilization counters are stubs, so they cannot gate stall warnings.
  V8-shaped memory counters likewise should not be interpreted as V8 heap layout.

Host/process resource telemetry observes provider and terminal children as well as
the server. Bun's own heap statistics cannot replace that cross-process view.
RSS, JavaScript heap size, and macOS physical footprint measure different things;
forced collection is a diagnostic operation, not the normal memory baseline.

## Evidence for a future adapter change

Use a concrete incompatibility or measured workload to choose an adapter. Compare
startup, idle CPU, memory, and the affected operation using comparable source and
packaged forms with fresh isolated state. The [Bun 1.4.2 measurements](https://gist.githubusercontent.com/Igloczek/1631efc0127b0ad05384482b494e14c6/raw/20b00dce23121c6ee958bf17a18033540313d6e4/bun-1.4.2-performance.md)
record the current migration's tradeoffs and methodology; they do not benchmark
the native replacements above or establish which adapter caused the RSS/CPU gap.

Keep focused behavioral tests for the changed boundary and verify the actual
standalone archive, including helpers without system Node/npm/Bun. HTTP changes
also need authenticated transport/Browser-stream and real-client coverage.
Follow AGENTS.md for test scope, disposable state, and browser consent. These
candidates retain migration knowledge; implementing one requires a separate task.
