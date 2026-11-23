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
separately from the main agent's. Events include the model ID the provider
used, including custom models and models served by a custom endpoint.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. The one exception is [agent feedback](#agent-feedback),
which is off unless you turn it on.

## Agent feedback

Agent feedback lets agents tell the iglo.code maintainers about iglo.code: an iglo.code tool or `iglo.code` command that did not
do what they expected, a confusing instruction, or a missing capability. Choose a mode in
**Agent feedback** in **Settings > Labs**:

- **Off**, the default: agents do not see the feedback tools, and `iglo.code feedback` stops with a
  message pointing to Labs.
- **When I ask**: agents send a report only when you ask them to, about anything in iglo.code.
- **Automatic**: agents also report iglo.code problems they hit on their own, such as an iglo.code tool that
  failed and made them find another way. These reports carry no outline and no message text, and
  go out without asking you. `iglo.code feedback --kind bug --subject "iglo.code thread send" --expected "…" --actual "…"`
  sends one the same way, so it works only in this mode.

When you ask your agent for a report, in either mode, iglo.code shows it in the thread as a card
with exactly what would leave your machine, and sends it only if you press **Send**. The agent
carries on without waiting and never learns your answer. The card stays open until you answer it,
even after the turn ends or the server restarts; **Don't send** sends nothing, and the agent is
told not to send it another way. Only someone who can run agents on that machine can answer the
card; people on a guest link cannot.

Each report has the kind of problem, the iglo.code tool or command it concerns (or `general`), and up to
300 characters each of expected behavior, actual behavior, and workaround, written by the agent,
which is told not to quote your messages or code. The agent also says how many recent turns the
problem spans. A report you approved carries an outline of those turns, and of at least the last 5,
from when the agent asked: who spoke, how long each message was, and which tools ran, whether they
worked, and how long they took. The outline has no text. Tools from your other MCP servers appear
only as `mcp`. Turn on **Include the conversation** in the card to attach the text of your
messages and the agent's replies in the turns the problem spans, up to 1,000 characters per
message and 16 KB in all, oldest text dropped first; the card shows that text before you send it.
To change a report, such as the turns it covers, ask the agent in the chat: it shows a new card,
and you can decline the old one. Tool inputs and outputs, files, and attachments are never sent. An agent can
show you at most 3 report cards and send 3 reports on its own per turn, and `iglo.code feedback` can
send at most 10 an hour.

Before anything is saved, iglo.code removes file paths (when text mentions one, the rest of that line
goes with it), your user name, machine name, project title, branch, and git remote, and anything
that looks like a key, token, email address, or URL with a password. It cannot recognise your code
or a name written in a sentence, so only include the conversation when it holds nothing you would
not send. Reports from agents also name the provider and the model. No thread IDs or project IDs
are sent.

Reports are saved on your machine first, and a declined one is not saved at all; its card keeps
only what you would have sent without the conversation. A report leaves your machine only when
`IGLO_CODE_POSTHOG_HOST` is set; otherwise, and when product usage
data is turned off, saved reports stay there and are not sent. `iglo.code feedback list` shows recent
reports, the thread each came from, and a line for each outline; `iglo.code feedback list --json` shows
exactly what each one holds.

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
