# Product usage data

iglo.code sends no product usage events by default. Nothing leaves your machine
unless you set `IGLO_CODE_POSTHOG_HOST` to a PostHog-compatible endpoint you
run (and `IGLO_CODE_POSTHOG_KEY` if it needs a project key) in the server's
environment before starting it.

With an endpoint set, events are associated with a hashed installation
identifier. To count how many installations one person uses, the server also
sends hashed account identifiers: your OpenAI and Claude accounts when you are
signed in, and a random identifier for each device that connects. Events include the provider, model,
reasoning effort, permission mode, turn and request results, duration, release
channel, and token counts when available. Child-agent token counts are reported
separately from the main agent's. Model names are sent only when they appear in
a provider's public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

To turn product events off again, remove `IGLO_CODE_POSTHOG_HOST` or set
`IGLO_CODE_TELEMETRY_ENABLED=false`, for the background service in
[`service.env`](./background-service.md#configure-the-service-environment). An
administrator can also turn them off with a
[managed policy](./managed-policy.md#other-capabilities).

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`IGLO_CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `IGLO_CODE_OTLP_*_URL`, set `IGLO_CODE_OTLP_HEADERS` for
receivers that need authentication and `IGLO_CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
