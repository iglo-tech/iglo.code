import * as Schema from "effect/Schema";

import { AuthEnvironmentScope, AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/**
 * A link from this environment to another one (the peer). This environment
 * signed in to the peer's `/mcp` as an outside agent, with a pairing code from
 * the peer, so its agents can work there. The peer enforces the link's access (full access for every link made now; an older
 * link may be lower), and revokes the link from its own Connections.
 */
export const PeerLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Addresses the peer was linked at, tried in order. */
  urls: Schema.Array(TrimmedNonEmptyString),
  /** Full access for every link made now; a link from an older version may be lower. */
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

/**
 * A link's name only, for a client that may read threads here but not manage access: enough to
 * name and open a linked environment's threads, without its addresses, access or health.
 */
export const PeerLinkName = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
});
export type PeerLinkName = typeof PeerLinkName.Type;

export const PeerLinkCreateInput = Schema.Struct({
  /** Where the peer answers: an https, Tailscale, LAN or loopback base URL. */
  url: TrimmedNonEmptyString,
  /** More addresses for the same peer, tried after `url`. */
  alternateUrls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** A pairing code from the peer (`iglo.code pair` there, or its Connections settings). */
  pairingCode: TrimmedNonEmptyString,
  /** Ignored by this server, which always links at full access; older servers require it. */
  access: Schema.optionalKey(AuthMcpClientAccess),
  /**
   * Also link this environment back to the peer, at full access too, when the
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
const MAX_RECIPROCAL_OFFER_LABEL_LENGTH = 200;

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

/**
 * Where a linked peer says it answers now, sent over its link session, and the receiver's own
 * addresses in reply. Each side adds only the addresses that answer as the other, so a link made
 * while an address was not ready yet (a Tailscale certificate still being issued) picks it up later.
 * The receiver probes them, so the count is bounded as an offer's is.
 */
export const PeerLinkOriginsExchange = Schema.Struct({
  environmentId: EnvironmentId,
  urls: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(MAX_RECIPROCAL_OFFER_URLS)),
});
export type PeerLinkOriginsExchange = typeof PeerLinkOriginsExchange.Type;

export const PeerLinkOriginsAnswer = Schema.Struct({
  urls: Schema.Array(TrimmedNonEmptyString),
});
export type PeerLinkOriginsAnswer = typeof PeerLinkOriginsAnswer.Type;

/** Checks a link now: an authenticated call to the peer, recorded on the link. */
export const PeerLinkCheckInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkCheckInput = typeof PeerLinkCheckInput.Type;

export const PeerLinkRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkRemoveInput = typeof PeerLinkRemoveInput.Type;

export const PeerLinkRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  /** What came of asking the peer to forget its link back, when a token was still held. */
  remote: Schema.optionalKey(PeerLinkTeardownOutcome),
  // Whether the peer ended the link's session. Older servers never ask it to.
  endedThere: Schema.optionalKey(Schema.Boolean),
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
  /** The environment that answered at the addresses of the one the user picked, when one did. */
  answeredAs: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** What went wrong with one link, as a batch reports it per machine. */
export type PeerLinkFailureKind = "unreachable" | "code_refused" | "wrong_environment" | "other";

export const peerLinkFailureKind = (
  error: Pick<PeerLinkError, "reason" | "answeredAs">,
): PeerLinkFailureKind =>
  error.answeredAs !== undefined
    ? "wrong_environment"
    : error.reason === "unreachable" || error.reason === "not_a_t3_environment"
      ? "unreachable"
      : error.reason === "pairing_rejected"
        ? "code_refused"
        : "other";

/**
 * Where an environment serves one of its threads to an environment linked to it, signed in with
 * the link's own session as on `/mcp`. The stream carries the same items the owner's thread
 * subscription does; history pages and item detail are the owner's too.
 */
const PEER_LINK_THREAD_ROUTE_PREFIX = "/api/links/thread";
export const PEER_LINK_THREAD_STREAM_ROUTE = `${PEER_LINK_THREAD_ROUTE_PREFIX}/stream`;
export const PEER_LINK_THREAD_HISTORY_ROUTE = `${PEER_LINK_THREAD_ROUTE_PREFIX}/history`;
export const PEER_LINK_THREAD_ITEM_ROUTE = `${PEER_LINK_THREAD_ROUTE_PREFIX}/item`;

const PEER_LINK_HOST_HEALTH_ROUTE_PREFIX = "/api/links/host-health";
export const PEER_LINK_HOST_HEALTH_SNAPSHOT_ROUTE = `${PEER_LINK_HOST_HEALTH_ROUTE_PREFIX}/snapshot`;
export const PEER_LINK_HOST_HEALTH_HISTORY_ROUTE = `${PEER_LINK_HOST_HEALTH_ROUTE_PREFIX}/history`;

/** A thread on a linked environment, as a client of this environment names it. */
export const PeerLinkThreadInput = Schema.Struct({
  /** The linked environment the thread lives in. */
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type PeerLinkThreadInput = typeof PeerLinkThreadInput.Type;

export const PeerLinkThreadHistoryInput = Schema.Struct({
  ...PeerLinkThreadInput.fields,
  /** The `historyCursor` of the snapshot or of the page before. */
  cursor: TrimmedNonEmptyString,
});
export type PeerLinkThreadHistoryInput = typeof PeerLinkThreadHistoryInput.Type;

export const PeerLinkThreadItemInput = Schema.Struct({
  ...PeerLinkThreadInput.fields,
  itemId: TurnItemId,
  /** Unused by the server; a client keys its cache on it, as for its own threads' items. */
  revision: Schema.optional(Schema.String),
});
export type PeerLinkThreadItemInput = typeof PeerLinkThreadItemInput.Type;

/** Why a linked environment's thread could not be read, with the reason in words. */
export class PeerLinkThreadReadError extends Schema.TaggedError<PeerLinkThreadReadError>()(
  "PeerLinkThreadReadError",
  {
    reason: Schema.Literals([
      /** Linked environments is off here. */
      "disabled",
      "unknown_link",
      "expired",
      /** The linked environment no longer accepts the link, or refuses the read. */
      "rejected",
      "unreachable",
      "thread_not_found",
      /** The linked environment runs a version that does not serve its threads to a link. */
      "incompatible",
    ]),
    /** What this environment calls the linked one, when it still has the link. */
    label: Schema.NullOr(Schema.String),
    message: Schema.String,
    /** The failure underneath, when the read got as far as the link or the linked environment. */
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** A client of this environment asks to pair with one it links to, without typing a code. */
export const PeerLinkClientPairingInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkClientPairingInput = typeof PeerLinkClientPairingInput.Type;

/**
 * A client of this environment asks it for a pairing code from one it links to, to link another
 * environment there with: the linked one mints it, so the user fetches none.
 */
export const PeerLinkLinkPairingInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** Ignored by this server, which always links at full access; older servers require it. */
  access: Schema.optionalKey(AuthMcpClientAccess),
});
export type PeerLinkLinkPairingInput = typeof PeerLinkLinkPairingInput.Type;

const peerLinkClientPairingTarget = {
  environmentId: EnvironmentId,
  label: Schema.String,
  /** The addresses this environment reaches the linked one at; the client tries them itself. */
  urls: Schema.Array(TrimmedNonEmptyString),
};

/**
 * A one-time pairing credential from the linked environment, or why this link cannot get one, in
 * which case the user pairs there with a code of their own.
 */
export const PeerLinkClientPairingResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("credential"),
    ...peerLinkClientPairingTarget,
    credential: TrimmedNonEmptyString,
    expiresAt: Schema.DateTimeUtc,
  }),
  Schema.Struct({
    type: Schema.Literal("unsupported"),
    ...peerLinkClientPairingTarget,
    reason: Schema.Literals([
      /** The link is below full access, so it may not hand out a client's access. */
      "link_access",
      /** The linked environment runs a version from before this. */
      "version",
      /** The linked environment refused: the beta is off there, or its policy forbids pairing. */
      "refused",
      /** This environment could not reach the linked one; the client still might. */
      "unreachable",
    ]),
  }),
]);
export type PeerLinkClientPairingResult = typeof PeerLinkClientPairingResult.Type;

/** What a linking environment asks of the linked one, over the link, for one of its clients. */
export const PeerLinkClientPairingRequest = Schema.Struct({
  /** The client's scopes on the linking environment. The credential never carries more. */
  scopes: Schema.Array(AuthEnvironmentScope),
  /** The client's name there, shown in Connections here. */
  clientLabel: TrimmedNonEmptyString,
  /**
   * Set when the pairing is for a link from another environment, not for the client itself: the
   * credential is then a link pairing code at this access, and `scopes` is not used.
   */
  link: Schema.optionalKey(Schema.Struct({ access: AuthMcpClientAccess })),
});
export type PeerLinkClientPairingRequest = typeof PeerLinkClientPairingRequest.Type;

export const PeerLinkClientPairingCredential = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type PeerLinkClientPairingCredential = typeof PeerLinkClientPairingCredential.Type;

/**
 * The user's answer to an agent asking to link an environment. The pairing
 * code is used once to link and is never recorded; the thread learns only the
 * outcome.
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
      /** Ignored by this server, which always links at full access; older servers require it. */
      access: Schema.optionalKey(AuthMcpClientAccess),
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
