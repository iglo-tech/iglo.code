# Product analytics

The server owns analytics delivery, opt-out, and identity for every connected client. Clients never
load the PostHog browser SDK, PostHog person profiles stay disabled, and loading the web client without
an authenticated connection does not count as product use. iglo.code sends nothing unless
`IGLO_CODE_POSTHOG_HOST` names an endpoint (upstream's `ingest.t3.codes` is not contacted).

## Identity

- **Never change `distinct_id`.** It preserves historical continuity in PostHog charts; add fields
  instead of changing how it is computed.
- **Count installs with `installId`, resolve owners at query time.** `installId` is a stable hash
  persisted in the state directory; `install.owner_observed` links installs to owners (OpenAI
  `user_id`—not the shared Codex Team `account_id` or per-login `sub`—Claude id, client device;
  upstream's Connect account is never present here).
- **Hash everywhere with [one helper](../../packages/shared/src/telemetryId.ts).** Clients and
  servers hash with the same SHA-256 helper so IDs correlate; the server accepts only hashes from
  clients.

## Attribution boundaries

- Client dimensions (`surface`, etc.) belong to the event's WebSocket connection, never a
  server-global "current client". Keep client and server dimensions separate, and leave missing
  client metadata unknown rather than backfilling from server properties.
- Active-use reports count `client.turn.requested` (deduplicated by command ID), not connections
  (clients reconnect often, on network changes or token renewal).

## Collection boundary and delivery

- Payloads stay strictly to product metadata, closed contract enums, and normalized measurements:
  never attach prompts, file paths, credentials, raw provider payloads, device names, conversation
  IDs, user-named provider instance IDs, or non-vendor/custom model names.
- The sole exception is opt-in `agent.feedback`, which
  [`FeedbackService`](../../apps/server/src/feedback/FeedbackService.ts) scrubs of paths, private
  values, and secret-shaped strings, and only attaches bounded conversation traces when the user
  explicitly previews and sends them.
- Delivery ([`AnalyticsService.ts`](../../apps/server/src/telemetry/AnalyticsService.ts)) attaches a
  UUID per event, backs off on failure, and drops batches after bounded retries so a stuck batch
  cannot loop forever.
- Dev-runner servers and the archive smoke test disable telemetry by default so they do not inflate
  install counts; set `IGLO_CODE_TELEMETRY_ENABLED=true` to test locally.
