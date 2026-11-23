import { AgentFeedbackKind, AgentFeedbackTrace } from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Code points, as the scrubber caps them, so a valid input stays a valid report after redaction.
const FeedbackText = Schema.String.check(Schema.isMaxCodePoints(300));

/** Turns the outline of a requested report covers at least. */
export const FEEDBACK_TRACE_TURNS = 5;

const reportFields = {
  kind: AgentFeedbackKind,
  subject: Schema.String.annotate({
    description: "T3 tool name, `iglo.code` command, or `general`.",
  }),
  expected: FeedbackText,
  actual: FeedbackText,
  workaround: FeedbackText.annotate({ description: "What you did instead, or empty." }),
  // Annotate before the default: an annotation after it never reaches the JSON schema.
  userRequested: Schema.Boolean.annotate({ description: "The user asked for this report." }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
};

export const FeedbackInput = Schema.Struct({
  ...reportFields,
  turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description: "How many recent turns, counting this one, the problem spans.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
});

export const FeedbackTrace = AgentFeedbackTrace;
export type FeedbackTrace = AgentFeedbackTrace;

const storedFields = {
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  source: Schema.Literals(["mcp", "cli"]),
  sent: Schema.Boolean,
};

export const FeedbackReport = Schema.Struct({
  ...reportFields,
  ...storedFields,
  trace: Schema.NullOr(FeedbackTrace),
});

/** What `t3_feedback` answers: the report, with only the size of what its trace attached. */
export const FeedbackSubmitResult = Schema.Struct({
  ...reportFields,
  ...storedFields,
  trace: Schema.NullOr(FeedbackTrace.mapFields(Struct.omit(["entries"]))),
});

export const FEEDBACK_AWAITING_APPROVAL_NOTE =
  "The user sees this report in a card and chooses there whether to send it and whether to include the conversation. Nothing is sent until they do, and you will not learn their choice. Do not wait for it or send it another way. Call again only if the user asks to change it; that shows a new card.";

/** What `t3_feedback` answers for a requested report: shown to the user, not yet sent. */
export const FeedbackAwaitingApproval = Schema.Struct({
  status: Schema.Literal("awaiting_approval"),
  note: Schema.String,
});
export type FeedbackAwaitingApproval = typeof FeedbackAwaitingApproval.Type;

export const FEEDBACK_OFF_MESSAGE =
  "Agent feedback is off. Turn it on in T3 Code under Settings > Labs, then try again.";

export class FeedbackOffError extends Schema.TaggedError<FeedbackOffError>()(
  "FeedbackOffError",
  {},
) {
  override get message() {
    return FEEDBACK_OFF_MESSAGE;
  }
}

export type FeedbackSource = "mcp" | "cli";

// Requested reports count when their card is shown, unprompted ones when stored.
export const MAX_REPORTS_PER_TURN = 3;
// Reports from no turn, such as `iglo.code feedback`, have no turn to count in.
export const MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR = 10;

export class FeedbackLimitError extends Schema.TaggedError<FeedbackLimitError>()(
  "FeedbackLimitError",
  { scope: Schema.Literals(["turn", "hour", "cards"]) },
) {
  override get message() {
    switch (this.scope) {
      case "turn":
        return `This turn already sent ${MAX_REPORTS_PER_TURN} agent feedback reports; nothing was sent.`;
      case "cards":
        return `This turn already showed the user ${MAX_REPORTS_PER_TURN} agent feedback reports to approve; nothing was shown.`;
      case "hour":
        return `This machine already sent ${MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR} agent feedback reports outside a turn in the last hour; nothing was sent.`;
    }
  }
}

export class FeedbackNotRequestedError extends Schema.TaggedError<FeedbackNotRequestedError>()(
  "FeedbackNotRequestedError",
  { source: Schema.Literals(["mcp", "cli"]) },
) {
  override get message() {
    return this.source === "cli"
      ? "Agent feedback is set to When I ask: ask your agent in a thread to send it, so you can approve what is sent."
      : "Agent feedback is set to When I ask: send a report only when the user asks for one.";
  }
}

export class FeedbackStorageError extends Schema.TaggedError<FeedbackStorageError>()(
  "FeedbackStorageError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not save agent feedback.";
  }
}

/** The MCP client label `iglo.code feedback` signs in with, so its reports count as `cli`. */
export const FEEDBACK_CLI_CLIENT_LABEL = "iglo.code feedback cli";

/** Listed `iglo.code` command paths a report may name. A CLI test keeps this in step with binCli. */
export const T3_CLI_COMMANDS: ReadonlyArray<string> = [
  "iglo.code",
  "iglo.code help",
  "iglo.code serve",
  "iglo.code app",
  "iglo.code pair",
  "iglo.code auth",
  "iglo.code auth connect-device",
  "iglo.code auth connect-device approve",
  "iglo.code auth connect-device list",
  "iglo.code auth connect-device revoke",
  "iglo.code auth pairing",
  "iglo.code auth pairing create",
  "iglo.code auth pairing list",
  "iglo.code auth pairing revoke",
  "iglo.code auth session",
  "iglo.code auth session issue",
  "iglo.code auth session list",
  "iglo.code auth session revoke",
  "iglo.code environment",
  "iglo.code environment link",
  "iglo.code environment list",
  "iglo.code environment unlink",
  "iglo.code browser",
  "iglo.code browser setup",
  "iglo.code project",
  "iglo.code project add",
  "iglo.code project remove",
  "iglo.code project rename",
  "iglo.code thread",
  "iglo.code thread list",
  "iglo.code thread start",
  "iglo.code thread send",
  "iglo.code thread show",
  "iglo.code feedback",
  "iglo.code feedback list",
  "iglo.code workflow",
  "iglo.code workflow start",
  "iglo.code workflow list",
  "iglo.code workflow show",
  "iglo.code workflow resume",
  "iglo.code workflow cancel",
  "iglo.code workflow signal",
  "iglo.code workflow questions",
  "iglo.code workflow hooks",
  "iglo.code workflow store",
  "iglo.code workflow store list",
  "iglo.code workflow store set",
  "iglo.code workflow store delete",
  "iglo.code up",
  "iglo.code status",
  "iglo.code service",
  "iglo.code service install",
  "iglo.code service restart",
  "iglo.code service uninstall",
  "iglo.code service status",
  "iglo.code service protect",
  "iglo.code update",
  "iglo.code install",
  "iglo.code uninstall",
  "iglo.code theme",
  "iglo.code theme set",
  "iglo.code theme clear",
  "iglo.code theme show",
  "iglo.code trace",
  "iglo.code trace summary",
  "iglo.code doctor",
  "iglo.code policy",
  "iglo.code policy show",
  "iglo.code policy check",
  "iglo.code policy templates",
  "iglo.code policy settings",
  "iglo.code triage",
  "iglo.code connect",
  "iglo.code connect link",
  "iglo.code connect login",
  "iglo.code connect logout",
  "iglo.code connect publish",
  "iglo.code connect status",
  "iglo.code connect unlink",
];

export type FeedbackInput = typeof FeedbackInput.Type;
export type FeedbackReport = typeof FeedbackReport.Type;

export const FEEDBACK_SUBJECT_MESSAGE =
  "Set subject to the exact T3 tool name, the iglo.code command, or `general`.";

// The shared resolver knows the presented tools; the prefix covers the rest, such as these.
// Codex also registers `iglo-code-direct` for T3 tools it keeps out of Code Mode.
const T3_PREFIX = /^(?:mcp__iglo[-_]?code(?:[-_]direct)?__|iglo[-_]?code(?:[-_]direct)?[.:/])/iu;

/** The bare name of a registered T3 tool however a provider prefixed it, else undefined. */
export const resolveT3ToolName = (name: string, toolNames: ReadonlyArray<string>) => {
  const tool = resolveT3McpToolId(name) ?? name.replace(T3_PREFIX, "");
  if (toolNames.includes(tool)) return tool;
  // OpenCode 2 prefixes tools with `iglo-code-<thread>_`, underscores and all: the longest name wins.
  if (!/^iglo-code-/iu.test(name)) return undefined;
  return toolNames
    .filter((candidate) => name.endsWith(`_${candidate}`))
    .toSorted((a, b) => b.length - a.length)[0];
};

/** The stored subject, or undefined when the value names no T3 tool, `iglo.code` command, or `general`. */
export const resolveFeedbackSubject = (value: string, toolNames: ReadonlyArray<string>) => {
  const subject = value.trim();
  if (subject === "general" || T3_CLI_COMMANDS.includes(subject)) return subject;
  return resolveT3ToolName(subject, toolNames);
};
