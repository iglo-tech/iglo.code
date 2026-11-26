# Observability

Server observability has three outputs: pretty stdout logs (not persisted locally, except SSH-managed launches at `~/.iglo.code/ssh-launch/<state>/server.log`, truncated on each launch), a local NDJSON trace file (always on), and optional OTLP export (traces, metrics, logs).

## Local traces and event-loop stalls

Default trace paths (`server.trace.ndjson`):

- Production / explicit `--home-dir` / `IGLO_CODE_HOME`: `<home>/userdata/logs/server.trace.ndjson`
- Linked worktree dev run: `<worktree>/.iglo.code/userdata/logs/server.trace.ndjson`
- Non-worktree dev run: `~/.iglo.code/dev/logs/server.trace.ndjson`

Summarize counts, rates, and latency percentiles offline (even while a server is stalled or stopped):

```sh
iglo.code trace summary --since 30m --limit 40
# Set IGLO_CODE_TRACE_FILE=/path/to/server.trace.ndjson for dev or copied traces
```

Logs emitted inside an active span (`Effect.log*`) attach as span events unless `IGLO_CODE_OTLP_LOGS_URL` is configured (which exports all log records directly to avoid duplicates).

Event-loop stalls (>2 s) write `server.eventLoop.stall` spans and append to `event-loop-stalls.ndjson` beside the trace file. Bun reports stub utilization counters, so the [monitor](../../apps/server/src/observability/EventLoopMonitor.ts) uses histogram lateness and accounts for macOS sleep ([Bun runtime](../internals/bun-runtime.md)). SQLite spans carry `db.connection` (`writer`/`reader`) and `db.lock_wait_ms` (queue wait off the event loop; subtract it before blaming query speed). Metrics live only in-process unless OTLP export is enabled.

At trace level Info or above (the default), with timing enabled, the local server file samples routine spans: SQLite, workflow runs (step code, retry schedules, cleanup and the agent threads a run starts are excluded; spans an author adds in the workflow body itself are sampled), and spans marked with `routineSpan` from `@t3tools/shared/observability` (high-volume lookups and sweeps). A routine span that succeeds in under 10 ms without events is kept only when its own span ID ends in `00` (about one in 256). The key is per span, not per trace or parent, because background fibers share the server's boot trace and recurring ticks reuse one parent span. Counts and averages for these spans in the local file and Settings → Diagnostics are therefore a biased sample. `IGLO_CODE_TRACE_MIN_LEVEL=Debug` keeps everything. This sampling does not apply to OTLP export.

## Local OTLP stack (Grafana LGTM)

```sh
docker run --name lgtm -p 3000:3000 -p 4317:4317 -p 4318:4318 --rm -ti grafana/otel-lgtm
```

Open `http://localhost:3000` (`admin`/`admin`), export OTLP URLs in the shell, and restart the server from that same shell:

```sh
export IGLO_CODE_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export IGLO_CODE_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export IGLO_CODE_OTLP_LOGS_URL=http://localhost:4318/v1/logs
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=development
vp run dev
```

The background service does not read your shell: put the same variables in `~/.iglo.code/service.env` and run `iglo.code service restart`. The backend reads observability config at process start, so restart fully after changing it.

## OTLP configuration and kill switches

- **Endpoints:** `IGLO_CODE_OTLP_{TRACES,METRICS,LOGS}_URL` outrank standard `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` and `OTEL_EXPORTER_OTLP_ENDPOINT`. `IGLO_CODE_OTLP_HEADERS` / `IGLO_CODE_OTLP_PROTOCOL` (`http/json` default) apply only to `IGLO_CODE_OTLP_*` endpoints; `OTEL_EXPORTER_OTLP_*` endpoints read `OTEL_EXPORTER_OTLP_*` headers/protocol (`http/protobuf` default). See [user telemetry](../user/telemetry.md#export-diagnostics-to-your-own-receiver) for Settings precedence.
- **Service names are fixed:** `iglo-code-server` (backend, `service.namespace` `iglo-code`) and `iglo-code-web` (UI). `OTEL_SERVICE_NAME` is ignored; distinguish installs with `OTEL_RESOURCE_ATTRIBUTES` (e.g. `deployment.environment.name=staging`). App-specific attributes keep upstream's `t3code.` prefix.
- **Kill switches:** `IGLO_CODE_OTEL_SDK_DISABLED` (outranks `OTEL_SDK_DISABLED`, accepts standard boolean spellings; `OTEL_SDK_DISABLED` only accepts `true`) disables all OTLP export while keeping local traces and stdout intact. `OTEL_{TRACES,METRICS,LOGS}_EXPORTER=none` disables a single signal unless overridden by `IGLO_CODE_OTLP_*_URL`.
- **Trace tuning:** `IGLO_CODE_TRACE_FILE`, `IGLO_CODE_TRACE_MAX_BYTES`, `IGLO_CODE_TRACE_MAX_FILES`, `IGLO_CODE_TRACE_MIN_LEVEL`, `IGLO_CODE_TRACE_TIMING_ENABLED`.
- **Webhooks:** `t3_webhook_deliveries_total`'s `source` is always `direct`; the `relay` source and `duplicate` outcome belong to T3 Connect, which this fork disables ([T3 Connect](../internals/06_t3-connect.md)).
- **Instrumentation rules:** Trace operation boundaries via `Effect.fn("Service.operation")` (see [Effect services](../internals/02_effect-services.md)). Put high-cardinality IDs/paths on span attributes, never on metric labels.

## Heap snapshots

On macOS and Linux, send `SIGUSR2` to the server PID from `server-runtime.json` (in the server's state dir beside `logs/`) to write a V8-format snapshot of Bun's JavaScriptCore heap to `<logsDir>/server-<pid>-<timestamp>.heapsnapshot` for Chrome DevTools Memory tab:

```sh
pid="$(jq .pid "${IGLO_CODE_HOME:-$HOME/.iglo.code}/userdata/server-runtime.json")"
ps -p "$pid" -o command=   # verify it is the iglo.code server; never signal the service launcher
kill -USR2 "$pid"
```

- Writing pauses the server (up to a minute+ on large heaps) and needs roughly as much free RAM as the heap. Send once, and avoid on a swapping host.
- A process without the handler exits on `SIGUSR2`, and after a crash the file can keep a stale pid, so check it first.
- Snapshots contain tokens, secrets, and thread content. Never share them publicly, and delete them manually when finished.
