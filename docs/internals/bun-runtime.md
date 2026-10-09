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

## Native boundary decisions

### HTTP and WebSockets: retained

[#20](https://github.com/iglo-tech/iglo.code/issues/20) retains the Effect Node HTTP
and `ws`-compatibility transport in [server.ts](../../apps/server/src/server.ts).
On Bun 1.4.2, `Bun.serve` strips supplied `Content-Length` from streamed bodies,
including 206 ranges and raw compressed bodies. Buffering entire files would lose
streaming/backpressure; reopening validated paths would lose file identity.
Held-descriptor `Bun.file(fd).slice(a, b)` is no workaround: under `Bun.serve` it
sends the slice with the full-file length. Reopen when a supported Bun pin fixes
both framing defects; the unexplained dedicated-versus-shared compressor wire-byte
difference recorded in #20 must also be resolved before adoption.

Retention leaves a known incompatibility: Bun's `ws` compatibility path does not
negotiate requested permessage-deflate, so RPC frames reach remote, relay and
tunnel clients uncompressed. That problem remains unowned. Any replacement must
preserve RPC compression benefits and [Browser streams](../../apps/server/src/preview/ServerBrowserStream.ts)
with uncompressed JPEG frames, bounded pending bytes and immediate slow-viewer
cleanup; changing only the bootstrap layer is insufficient.

### File operations: inconclusive

[#21](https://github.com/iglo-tech/iglo.code/issues/21) keeps the existing read/write
paths. Callback spans include worker queueing and event-loop scheduling, so their
upper bounds do not establish intrinsic file cost. Attachment totals also include
the retained HTTP file-response implementation, outside this decision's scope.
Workspace FileHandle/promises reads, media validation and service writes lack
complete coverage. Native HTTP file responses remain outside scope while HTTP is
retained. The descriptor-slice failure above proves a transport-framing defect,
not a read/write incompatibility outside `Bun.serve`.

Reopen for a reproduced in-scope incompatibility or bounded source/actual-archive
attribution that separates intrinsic work from scheduling, covers the selected
owners and missing FileHandle/promises/stream operations, records drained bytes,
and establishes at least 5% cost in a declared end-to-end workload. Validated
[media](../../apps/server/src/assets/MediaFile.ts) and static reads must keep their
held descriptors, identity checks and cancellation cleanup; never reopen a path
merely to use `Bun.file`.

### SQLite: retained

[#22](https://github.com/iglo-tech/iglo.code/issues/22) retains
[nodeSqliteClient.ts](../../packages/shared/src/nodeSqliteClient.ts). On the
measured macOS arm64 source runtime, `node:sqlite` and `bun:sqlite` share the same
SQLite source ID and compile options; changing bindings does not change the
engine. Even removing all attributed synchronous SQLite work falls below D1's
compatibility range in both source and archive evidence. Separate replay deltas
changed sign. These are screening observations from distinct runs, not a universal
wall-time ceiling; archive/Linux engine identity remains unmeasured.

Reopen for a reproduced compatibility defect, differing engine metadata on a
supported pin/target, or a fresh compatibility batch whose range is below its
attributed SQLite union with a separate replay showing a binding delta of at least
5% of the end-to-end median. D2 may motivate reopening but cannot replace D1's
adoption metric. Establish catalog owner policy first: binding foreign-key
defaults differ, and core pragmas must not be generalized to plugin/catalog
databases. Matching engine metadata does not prove shared in-process locking
state; preserve binding ownership, atomic core persistence and separate plugin
transactions.

### Subprocesses: retained spawner, inconclusive shell and launcher

[#23](https://github.com/iglo-tech/iglo.code/issues/23) retains the Effect spawner
at environment-server and standalone-CLI composition, including provider CLI
consumers. Bun's `child_process` already uses native spawning. All observed P1
server CPU is below P1's compatibility wall-time range in both build forms;
resolving the exact spawner share alone cannot change that screening result.
This does not bound non-CPU waiting or establish coverage of active provider turns.
Reopen for a reproduced in-scope defect, or a fresh preregistered source/archive
P1 (or representative added workload) batch whose range is below its server CPU
and whose resolved spawner share is at least 5%. An added workload cannot override
unchanged nonqualifying P1 evidence.

Synchronous [login-shell/service-manager reads](../../packages/shared/src/shell.ts)
and the [launcher's server-child spawn](../../apps/server/src/serviceLauncher.ts)
remain **inconclusive**: operation-specific latency and parent cost are unmeasured;
P1 and functional lifecycle fixtures do not supply those fractions. Reopen either
for a reproduced in-scope defect or a declared source/archive workload resolving
at least 5% attributable parent cost. For shell reads, separate parent work from
child shell/manager execution. For launcher launch/handoff/rollback, use owned
disposable service identities and separate spawn/IPC/exit work from child startup,
intentional delays and staging/marker/backup I/O. Staging/marker files stay unchanged
unless separately attributed; preserve same-protocol IPC, handoff and rollback.

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

The [#19 baseline/results](https://github.com/iglo-tech/iglo.code/issues/19#issuecomment-6069109408)
and [immutable evidence](https://gist.github.com/Igloczek/caf01a93a62151222724aca1c6c26553/8cc8a719a3151dc9ca7f2728c3a2291056ef4758)
cover Bun 1.4.2 at `d5cee2d8fa`, source and actual macOS arm64 archive. No adapter
was accepted afterwards. Linux was never measured, and the dev-runner WebSocket
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
