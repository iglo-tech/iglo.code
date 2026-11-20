import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/**
 * A link from this environment to another one (the peer). This environment
 * signed in to the peer's `/mcp` as an outside agent, with a pairing code from
 * the peer, so its agents can work there. The peer enforces the access chosen
 * at linking, and revokes the link from its own Connections.
 */
export const PeerLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Addresses the peer was linked at, tried in order. */
  urls: Schema.Array(TrimmedNonEmptyString),
  access: AuthMcpClientAccess,
  linkedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type PeerLink = typeof PeerLink.Type;

/** Whether a link can be used now, as worked out when it is listed. */
export const PeerLinkStatus = Schema.Literals(["reachable", "unreachable", "expired"]);
export type PeerLinkStatus = typeof PeerLinkStatus.Type;

export const PeerLinkSummary = Schema.Struct({
  ...PeerLink.fields,
  status: PeerLinkStatus,
});
export type PeerLinkSummary = typeof PeerLinkSummary.Type;

export const PeerLinkCreateInput = Schema.Struct({
  /** Where the peer answers: an https, Tailscale, LAN or loopback base URL. */
  url: TrimmedNonEmptyString,
  /** More addresses for the same peer, tried after `url`. */
  alternateUrls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** A pairing code from the peer (`iglo.code pair` there, or its Connections settings). */
  pairingCode: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
  /**
   * Also link this environment back to the peer with the same access, when the
   * peer accepts reciprocal links. Unset means no reciprocal link: older
   * callers that never chose link one way. First-party clients send it explicitly.
   */
  reciprocal: Schema.optionalKey(Schema.Boolean),
  /**
   * The environment the user means. Addresses that answer as another one are
   * skipped, and only those that answer as this one are kept.
   */
  expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
  /** What the user calls that environment, to name it when it cannot be reached. */
  expectedLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PeerLinkCreateInput = typeof PeerLinkCreateInput.Type;

/** What came of also linking this environment back to the peer. */
export const PeerLinkReciprocalOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("linked") }),
  /** The peer runs a version without reciprocal links, so it linked one way. */
  Schema.Struct({ kind: Schema.Literal("unsupported") }),
  /** Linking offered no reciprocity, because the user turned it off. */
  Schema.Struct({ kind: Schema.Literal("off") }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    /** Why the peer could not link back, in words a user can act on. */
    message: Schema.String,
  }),
]);
export type PeerLinkReciprocalOutcome = typeof PeerLinkReciprocalOutcome.Type;

/**
 * A made link, flat, with what came of also linking back. Flat so an older
 * client that decodes a plain `PeerLink` still succeeds: the extra optional
 * key is dropped on decode. Likewise a newer client decodes an older server's
 * plain link, with `reciprocal` absent.
 */
export const PeerLinkCreateResult = Schema.Struct({
  ...PeerLink.fields,
  reciprocal: Schema.optionalKey(PeerLinkReciprocalOutcome),
});
export type PeerLinkCreateResult = typeof PeerLinkCreateResult.Type;

/** What answering a link request made, for the client to say aloud. */
export const PeerLinkRequestAnswerResult = Schema.Struct({
  /** The link an answer of "link" made, with what came of linking back. */
  result: Schema.optionalKey(PeerLinkCreateResult),
});
export type PeerLinkRequestAnswerResult = typeof PeerLinkRequestAnswerResult.Type;

/** What came of asking the peer to forget its link back here. */
export const PeerLinkTeardownOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("removed") }),
  /**
   * The peer answered but kept its side — a link from before sessions were
   * bound to rows, or one its session is not bound to. The caller can still
   * end the peer's session here itself; the message says how.
   */
  Schema.Struct({
    kind: Schema.Literal("kept"),
    /** Why it kept its side, in words a user can act on. */
    message: Schema.String,
  }),
  /** The peer could not be asked: the link back stays until removed there. */
  Schema.Struct({
    kind: Schema.Literal("off"),
    /** Why, in words a user can act on. */
    message: Schema.String,
  }),
]);
export type PeerLinkTeardownOutcome = typeof PeerLinkTeardownOutcome.Type;

/** Most addresses a reciprocal offer may carry, so one session cannot scan many. */
export const MAX_RECIPROCAL_OFFER_URLS = 8;
/** Most characters an offer's label may carry. */
export const MAX_RECIPROCAL_OFFER_LABEL_LENGTH = 200;

/**
 * A linked peer's offer to link back: its addresses and a one-time pairing
 * code it minted, delivered over the session its forward link holds here.
 * The addresses are probed by the receiver, so the count and lengths are
 * bounded: the offer must not turn into a port scanner.
 */
export const PeerLinkReciprocalOffer = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(MAX_RECIPROCAL_OFFER_LABEL_LENGTH)),
  /** Where the offering environment answers, most preferred first. */
  urls: Schema.NonEmptyArray(TrimmedNonEmptyString).check(
    Schema.isMaxLength(MAX_RECIPROCAL_OFFER_URLS),
  ),
  /** A pairing code from the offering environment, spent to link back to it. */
  pairingCode: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
});
export type PeerLinkReciprocalOffer = typeof PeerLinkReciprocalOffer.Type;

/** A linked peer asking this one to forget it: drop its link back and end its session here. */
export const PeerLinkReciprocalTeardownInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkReciprocalTeardownInput = typeof PeerLinkReciprocalTeardownInput.Type;

export const PeerLinkReciprocalTeardownResult = Schema.Struct({
  removed: Schema.Boolean,
  /** Whether a link to this environment still stands there, which a one-way link never had. */
  kept: Schema.Boolean,
});
export type PeerLinkReciprocalTeardownResult = typeof PeerLinkReciprocalTeardownResult.Type;

export const PeerLinkRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkRemoveInput = typeof PeerLinkRemoveInput.Type;

export const PeerLinkRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  /** What came of asking the peer to forget its link back, when a token was still held. */
  remote: Schema.optionalKey(PeerLinkTeardownOutcome),
});
export type PeerLinkRemoveResult = typeof PeerLinkRemoveResult.Type;

/** Why linking or calling a peer failed, in words a user can act on. */
export class PeerLinkError extends Schema.TaggedError<PeerLinkError>()("PeerLinkError", {
  reason: Schema.Literals([
    "unreachable",
    "not_a_t3_environment",
    "incompatible",
    "self",
    "pairing_rejected",
    "expired",
    "unknown_link",
    "storage",
    "disabled",
  ]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The user's answer to an agent asking to link an environment. The pairing
 * code is used once to link and is never recorded; the thread learns only the
 * outcome and the access the user chose.
 */
export const PeerLinkRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("link"),
      /** The machine the user picked, when they picked one rather than typing an address. */
      environmentId: Schema.optionalKey(EnvironmentId),
      /** What the client calls that machine. */
      label: Schema.optionalKey(TrimmedNonEmptyString),
      /** The addresses the client knows for that machine, most preferred first. */
      urls: Schema.NonEmptyArray(TrimmedNonEmptyString),
      access: AuthMcpClientAccess,
      pairingCode: TrimmedNonEmptyString,
      /** Also link this environment back to that machine. Unset means one way. */
      reciprocal: Schema.optionalKey(Schema.Boolean),
    }),
    /** Answers with a machine this environment is already linked to, as it is. */
    Schema.Struct({ type: Schema.Literal("use-existing"), environmentId: EnvironmentId }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type PeerLinkRequestAnswerInput = typeof PeerLinkRequestAnswerInput.Type;

const PEER_LINK_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the link request.",
  not_found: "This link request no longer exists.",
  already_answered: "This link request was already answered.",
  record_failed: "Could not update the link request.",
} as const;

export const PeerLinkRequestFailureReason = Schema.Literals(
  Object.keys(PEER_LINK_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof PEER_LINK_REQUEST_FAILURE_MESSAGES
  >,
);
export type PeerLinkRequestFailureReason = typeof PeerLinkRequestFailureReason.Type;

/**
 * Answering a link request failed before anything was linked. A link the
 * other environment refused is not this error: the card records it as failed.
 */
export class PeerLinkRequestError extends Schema.TaggedError<PeerLinkRequestError>()(
  "PeerLinkRequestError",
  {
    reason: PeerLinkRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return PEER_LINK_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
