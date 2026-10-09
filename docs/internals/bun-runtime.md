# Bun runtime boundaries

The fork runs its application server and helpers on Bun, while retaining Effect
services and working Node-compatible APIs. The migration changed the runtime and
packaging first, replacing APIs where compatibility failed. The native-boundary
evaluation below accepted no replacement; a native API name alone does not
establish a benefit.

Keep domain services, typed errors, scoped resource cleanup, and the event-sourced
orchestrator independent of the platform implementation. An adapter change must
preserve those behaviors rather than spread direct Bun calls through features.
Vite+/pnpm and their Node contributor toolchain are a separate concern.

Effect's read-only reference under `.repos/effect-smol` contains `BunHttpServer` and a
`sql-sqlite-bun` adapter; inspect them before inventing equivalents. Check their
implementation and compatibility against the dependency version being adopted.
In the Effect 4.0.1 reference, `packages/platform/bun/src/BunFileSystem.ts` uses
the shared Node filesystem implementation, and its sibling
`BunChildProcessSpawner.ts` re-exports the shared Node spawner. Switching to
`BunServices` alone therefore does not migrate those operations to `Bun.file` or
`Bun.spawn`.

## Native boundary decisions

### HTTP and WebSockets: retained

[#20](https://github.com/iglo-tech/iglo.code/issues/20) retains the Effect Node HTTP
and `ws`-compatibility transport in [server.ts](../../apps/server/src/server.ts).
Bun 1.4.2 `Bun.serve` strips supplied `Content-Length` from streamed bodies,
including 206 and raw compressed responses; held-descriptor `Bun.file(fd).slice(a, b)` sends slice bytes
with full-file length. Buffering loses streaming/backpressure; reopening loses
file identity. Explain #20's dedicated/shared compressor wire-byte anomaly first.

Reopen when a supported Bun pin fixes both framing defects, using the qualifying test in [#20](https://github.com/iglo-tech/iglo.code/issues/20).

The retained permessage-deflate incompatibility remains unowned: remote/relay/tunnel
RPC frames are uncompressed. Preserve compression benefits and [Browser streams](../../apps/server/src/preview/ServerBrowserStream.ts):
uncompressed JPEG frames, bounded pending bytes and immediate slow-viewer cleanup.

### File operations: inconclusive

[#21](https://github.com/iglo-tech/iglo.code/issues/21) keeps existing read/write paths:
callback bounds include queueing/scheduling; FileHandle/promises reads, validation
and writes lack coverage. Retained HTTP file responses remain outside scope.
The descriptor-slice failure is a `Bun.serve` framing defect; held-descriptor range
reads outside `Bun.serve` are untested and a validated-descriptor read candidate must
prove them first. [Media](../../apps/server/src/assets/MediaFile.ts) and static reads
must keep held descriptors, identity checks and cancellation cleanup; never reopen
validated paths to use `Bun.file`.

Reopen for a reproduced in-scope incompatibility or resolved intrinsic cost, using the qualifying test in [#21](https://github.com/iglo-tech/iglo.code/issues/21).

### SQLite: retained

[#22](https://github.com/iglo-tech/iglo.code/issues/22) retains [nodeSqliteClient.ts](../../packages/shared/src/nodeSqliteClient.ts).
`node:sqlite` and `bun:sqlite` share SQLite source ID/options on measured macOS arm64 source;
switching bindings does not change that engine. Removing all attributed core-write
SQLite work still falls below source/archive compatibility ranges; replay deltas
change sign. Separate-run screening is not a universal wall-time ceiling;
archive/Linux engine identity is unmeasured.
Reports-resolve cannot replace the core-write adoption metric.

Reopen for incompatibility, supported-target engine divergence or actionable binding cost, using the qualifying test in [#22](https://github.com/iglo-tech/iglo.code/issues/22).

Establish catalog owner policy first: foreign-key defaults differ; core pragmas
must not be generalized to plugin/catalog databases. Matching engines do not prove
shared locking; preserve binding ownership, atomic core persistence and separate
plugin transactions.

### Subprocesses: retained spawner, inconclusive shell and launcher

[#23](https://github.com/iglo-tech/iglo.code/issues/23) retains the Effect spawner.
Bun `child_process` already spawns natively; Git-status server CPU is below its
source/archive compatibility wall-time range. This does not bound non-CPU waiting
or cover active provider turns.

Reopen for an in-scope defect or actionable spawner cost, using the qualifying test in [#23](https://github.com/iglo-tech/iglo.code/issues/23).

[Shell/service-manager reads](../../packages/shared/src/shell.ts) and [launcher spawn](../../apps/server/src/serviceLauncher.ts)
remain inconclusive: operation latency and parent cost are unmeasured; Git-status
and lifecycle fixtures supply neither. Preserve same-protocol IPC, handoff and rollback.

Reopen either for an in-scope defect or resolved parent cost, using the qualifying test in [#23](https://github.com/iglo-tech/iglo.code/issues/23).

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

The [#19 baseline/results](https://github.com/iglo-tech/iglo.code/issues/19#issuecomment-6069109408)
and [immutable evidence](https://gist.github.com/Igloczek/caf01a93a62151222724aca1c6c26553/8cc8a719a3151dc9ca7f2728c3a2291056ef4758)
cover Bun 1.4.2 at `d5cee2d8fa`, source and actual macOS arm64 archive. No adapter
was accepted afterwards; the [PR #15 measurements](https://gist.githubusercontent.com/Igloczek/1631efc0127b0ad05384482b494e14c6/raw/20b00dce23121c6ee958bf17a18033540313d6e4/bun-1.4.2-performance.md)
record the Node-versus-Bun migration tradeoffs. Linux was never measured, and the dev-runner WebSocket
upgrade timeout remains unresolved. These measurements retain their documented
coverage/provenance limits and make no native replacement performance claim.

Reopening authorizes triage, not adoption. Use a concrete incompatibility or
resolved attributable cost before prototyping. Follow the
[evaluation gates](https://github.com/iglo-tech/iglo.code/issues/18) for matching
inputs, two independent alternating adoption/regression batches, all supported
source/archive targets and a genuine same-input upstream rehearsal. Compare
startup, idle CPU, memory and the affected operation with fresh isolated state;
keep RSS, platform footprint and heap measurements distinct.

Keep focused behavioral tests for the changed boundary and verify the actual
standalone archive, including helpers without system Node/npm/Bun. HTTP changes
also need authenticated transport/Browser-stream and real-client coverage.
Follow AGENTS.md for test scope, disposable state, and browser consent. Revisiting
these decisions requires a separate task; retained/inconclusive candidates leave
production adapters and composition unchanged.
