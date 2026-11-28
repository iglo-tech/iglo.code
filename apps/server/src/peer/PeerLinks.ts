import {
  AuthMcpClientAccess,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  EnvironmentAuthInvalidError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ExecutionEnvironmentDescriptor,
  MCP_PEER_LINK_SOFTWARE_ID,
  type PeerLink,
  type PeerLinkCreateInput,
  type PeerLinkCreateResult,
  PeerLinkError,
  type PeerLinkReciprocalOffer,
  type PeerLinkReciprocalOutcome,
  type PeerLinkReciprocalTeardownResult,
  type PeerLinkRemoveResult,
  type PeerLinkName,
  type PeerLinkOriginsAnswer,
  type PeerLinkOriginsExchange,
  type PeerLinkStatus,
  type PeerLinkSummary,
  type PeerLinkTeardownOutcome,
  PeerLinkReciprocalError,
  AuthSessionId,
  MAX_RECIPROCAL_OFFER_URLS,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OwnLinkOrigins from "./OwnLinkOrigins.ts";

const PeerHttpApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth)
  .add(EnvironmentHttpApi.groups.peerLinks)
  .annotateMerge(EnvironmentHttpApi.annotations);

/** The redirect registered for a link. Nothing ever listens there: the code comes back in the response. */
const LINK_REDIRECT_URI = "http://127.0.0.1/t3code-peer-link";
/**
 * How long a peer's descriptor or MCP handshake may take before a route counts
 * as unreachable. A tailnet or relayed route to a machine that is waking up takes longer.
 */
export const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);
/** How long a listing waits on a link's addresses; a real call still gives a waking peer `probeTimeout`. */
const LIST_PROBE_TIMEOUT = Duration.seconds(3);

/** Node's TLS verification code in a failed request's cause chain, if any. */
export const certificateErrorCode = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 6 && Predicate.isObject(current); depth++) {
    if (
      Predicate.hasProperty(current, "code") &&
      typeof current.code === "string" &&
      /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|INVALID_(CA|PURPOSE)|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH/.test(
        current.code,
      )
    )
      return current.code;
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return undefined;
};

/** A usable link: where to reach the peer and the token to send there. */
export interface ResolvedPeerLink {
  readonly link: PeerLink;
  /** The first address that answered as this peer. */
  readonly url: string;
  readonly token: string;
  /** What the peer said it can do when it answered. */
  readonly capabilities: ExecutionEnvironmentCapabilities;
}

/** What a link's session is called in the peer's Connections, before this environment's label. */
export const LINK_CLIENT_NAME_PREFIX = "iglo.code · ";

export const LINKED_ENVIRONMENTS_OFF =
  "Linked environments is off on this machine. Turn it on in Settings → Labs.";

/**
 * Links from this environment to others: an outside-agent OAuth sign-in to the
 * peer's `/mcp` with a pairing code from it, the token kept in the secret
 * store. By default the link also offers the peer a code to link back, so one
 * link serves both directions.
 */
export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    /** Whether the Linked environments beta (Settings → Labs) is on here. */
    readonly enabled: Effect.Effect<boolean>;
    readonly link: (
      input: PeerLinkCreateInput,
    ) => Effect.Effect<PeerLinkCreateResult, PeerLinkError>;
    /**
     * Links like `link`, except that a machine whose link has not expired is
     * kept, with its pairing code unused: it is checked instead, which trades
     * both sides' current addresses.
     */
    readonly linkUnlessLinked: (input: PeerLinkCreateInput) => Effect.Effect<
      {
        readonly link: PeerLink;
        readonly reciprocal: PeerLinkReciprocalOutcome;
        readonly alreadyLinked: boolean;
        /** For a machine already linked: how its link answered the check linking ran instead. */
        readonly status?: PeerLinkStatus;
      },
      PeerLinkError
    >;
    readonly list: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError>;
    /** The unexpired links' names, from what is stored, without asking any peer. */
    readonly names: Effect.Effect<ReadonlyArray<PeerLinkName>, PeerLinkError>;
    /** The stored link, without asking the peer whether it answers. */
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
    /**
     * Forgets the link here, and asks the peer to forget its link back and
     * end this side's session there. The peer keeps what it holds when it
     * cannot be reached; the result says so.
     */
    readonly unlink: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerLinkRemoveResult & { readonly endedThere: boolean }, PeerLinkError>;
    /**
     * A linked peer's offer to link back to it. The caller is the session the
     * peer's forward link holds here, and may only offer its own environment.
     */
    readonly acceptReciprocal: (
      caller: { readonly sessionId: AuthSessionId; readonly peerEnvironmentId: string | undefined },
      offer: PeerLinkReciprocalOffer,
    ) => Effect.Effect<PeerLink, PeerLinkError>;
    /**
     * A linked peer asking this environment to forget it: its link back goes,
     * and so does the session the call came over. The caller may only ask for
     * its own environment.
     */
    readonly forgetPeer: (
      caller: { readonly sessionId: AuthSessionId; readonly peerEnvironmentId: string | undefined },
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerLinkReciprocalTeardownResult, PeerLinkError>;
    /** An address that answers as the linked peer, with its token, ready to call. */
    readonly resolve: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ResolvedPeerLink, PeerLinkError>;
    /**
     * Checks the link now with an authenticated call to the peer, which also trades each
     * side's current addresses. A refusal is recorded on the link and a success clears what
     * an earlier call recorded; a peer that does not answer is listed unreachable and
     * leaves the record as it was.
     */
    readonly check: (environmentId: EnvironmentId) => Effect.Effect<PeerLinkSummary, PeerLinkError>;
    /**
     * A linked peer saying where it answers now. Its addresses that answer as it join
     * the link this environment holds to it, when that link is bound to the calling
     * session; the answer is this environment's own addresses.
     */
    readonly exchangeOrigins: (
      caller: { readonly sessionId: AuthSessionId; readonly peerEnvironmentId: string | undefined },
      offer: PeerLinkOriginsExchange,
    ) => Effect.Effect<PeerLinkOriginsAnswer, PeerLinkError>;
    /** Records the outcome of a call, so listing shows whether the peer answered last time. */
    readonly recordOutcome: (
      environmentId: EnvironmentId,
      outcome: { readonly error: string | null },
    ) => Effect.Effect<void>;
    /** Records a later end the peer gives the link's session: using a link renews it there. */
    readonly recordExpiry: (
      environmentId: EnvironmentId,
      expiresAt: DateTime.Utc,
    ) => Effect.Effect<void>;
  }
>()("t3/peer/PeerLinks") {}

/**
 * How long trading addresses waits. The peer may first wait out its own Serve
 * certificate (DirectEndpoints' TAILNET_NAME_PROBE_TIMEOUT), then probe ours.
 */
const ORIGINS_EXCHANGE_TIMEOUT = Duration.seconds(90);

/** Most addresses a link keeps; trading addresses only ever adds. */
const MAX_LINK_URLS = 16;

/** How long a reciprocal offer waits on the peer linking back here. */
const RECIPROCAL_OFFER_TIMEOUT = Duration.seconds(30);
/**
 * How long forgetting waits on the peer before it keeps its side. The peer's
 * own answer may probe back (up to its probe budget) and then hop on, so the
 * caller needs headroom over the peer's internal timeouts.
 */
const TEARDOWN_TIMEOUT = Duration.seconds(30);
/**
 * How long the hop a teardown makes back waits. It runs after this side's own
 * probe, so it stays well under the caller's teardown timeout.
 */
const TEARDOWN_HOP_TIMEOUT = Duration.seconds(10);

interface PeerLinkRow {
  readonly environment_id: string;
  readonly secret_name: string;
  readonly label: string;
  readonly urls_json: string;
  readonly access: string;
  readonly linked_at: string;
  readonly expires_at: string;
  readonly last_reached_at: string | null;
  readonly last_error: string | null;
  readonly fenced: number;
  /** The peer-link session this row is bound to, when it is: only that session may forget it. */
  readonly peer_session_id: string | null;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccess = Schema.decodeUnknownEffect(AuthMcpClientAccess);

/** Fails with a fixed storage error that keeps its cause; the log gets the details. */
const failStorage = (cause: unknown) =>
  Effect.logWarning("Peer link storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new PeerLinkError({
          reason: "storage",
          message:
            "Linked environments could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

/**
 * The base URL a peer is reached at, normalised to its origin. The pairing
 * code and then the link's token travel to it, so plain http is accepted only
 * where the network already encrypts: this machine, or a Tailscale address.
 */
const peerOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        // Never the address as given: it may hold a username, password or query.
        message: "That address is not an http or https address.",
      }),
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  ) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${parsed.origin} is plain http, which would send the link's credentials unencrypted. Use its https address, or its Tailscale name (*.ts.net).`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

/** The system error under a failed connection, such as ECONNREFUSED or ENOTFOUND. */
const connectionCode = (cause: unknown) =>
  [cause, Predicate.hasProperty(cause, "cause") ? cause.cause : undefined]
    .map((error) => (Predicate.hasProperty(error, "code") ? error.code : undefined))
    .find(Predicate.isString);

/** Why `origin` did not answer as iglo.code, short enough for a toast. Never echoes a body. */
const probeFailure = (
  origin: string,
  error: HttpClientError.HttpClientError | Schema.SchemaError | Cause.TimeoutError,
  timeout: Duration.Duration,
) => {
  const unreachable = (message: string) => new PeerLinkError({ reason: "unreachable", message });
  const certificate = certificateErrorCode(error);
  if (certificate !== undefined) {
    return unreachable(`${origin} presented a certificate this machine rejected (${certificate}).`);
  }
  if (Cause.isTimeoutError(error)) {
    return unreachable(`${origin} did not answer within ${Duration.toSeconds(timeout)} seconds.`);
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError") {
    const code = connectionCode(error.reason.cause);
    return unreachable(
      code === undefined ? `${origin} did not answer.` : `${origin} did not answer (${code}).`,
    );
  }
  return new PeerLinkError({
    reason: "not_a_t3_environment",
    message: `${origin} answered, but not as an iglo.code environment this version understands.`,
  });
};

/**
 * A route the server does not have, which on an iglo.code peer means an older
 * version. An undeclared status arrives as a DecodeError, which carries the
 * response too, so match the status whatever the reason is.
 */
const missingEndpoint = (error: HttpClientError.HttpClientError) =>
  (error.reason._tag === "StatusCodeError" || error.reason._tag === "DecodeError") &&
  error.reason.response.status === 404;

const isPeerLinkReciprocalError = Schema.is(PeerLinkReciprocalError);
const isManagedPolicyRefused = Schema.is(ManagedLimits.ManagedPolicyRefusedError);
const isAuthInvalid = Schema.is(EnvironmentAuthInvalidError);
const isHttpForbidden = Schema.is(EnvironmentHttpForbiddenError);

/** Why the peer did not link back, in words a user can act on. */
const reciprocalOfferFailure = (peer: string, error: unknown) => {
  if (isPeerLinkReciprocalError(error)) {
    return error.reason === "disabled"
      ? `Linked environments is off on ${peer}. Turn it on there, then link again.`
      : `${peer} could not link back: ${error.message}`;
  }
  if (EnvironmentAuth.isServerAuthInternalError(error)) {
    return "This environment could not mint the code the peer needs to link back. The server log has details.";
  }
  if (isManagedPolicyRefused(error)) {
    return "A managed policy on this machine refuses new pairing codes, so the peer could not link back.";
  }
  if (Cause.isTimeoutError(error)) {
    return `${peer} did not finish linking back within ${Duration.toSeconds(RECIPROCAL_OFFER_TIMEOUT)} seconds. Check its Connections; link again to retry.`;
  }
  if (isAuthInvalid(error) || isHttpForbidden(error)) {
    return `${peer} refused the session this environment signed in with. Link again with a fresh pairing code.`;
  }
  if (HttpClientError.isHttpClientError(error)) {
    return missingEndpoint(error)
      ? `${peer} runs an iglo.code version that does not link back. Update it, then link again.`
      : `${peer} stopped answering while linking back.`;
  }
  return `${peer} answered in a shape this version does not understand. Update both environments.`;
};

/** Why the peer kept its side when it was asked to forget, in words a user can act on. */
const teardownFailure = (peer: string, selfLabel: string, error: unknown) => {
  const revokeThere = `Revoke "iglo.code · ${selfLabel}" in ${peer}'s Sharing & access to end this side's session there.`;
  if (isPeerLinkReciprocalError(error)) {
    return `${peer} could not forget its link back: ${error.message}`;
  }
  if (Cause.isTimeoutError(error)) {
    return `${peer} did not answer in time. Forget its link there, in its Connections. ${revokeThere}`;
  }
  if (isAuthInvalid(error) || isHttpForbidden(error)) {
    return `This link's session no longer works on ${peer}. ${revokeThere}`;
  }
  if (HttpClientError.isHttpClientError(error)) {
    return missingEndpoint(error)
      ? `${peer} runs an iglo.code version that cannot forget a link from here. ${revokeThere}`
      : `${peer} stopped answering. Forget its link there, in its Connections. ${revokeThere}`;
  }
  return `${peer} answered in a shape this version does not understand. Forget its link there, in its Connections. ${revokeThere}`;
};

/** Whether a host is this machine's own loopback. Tests serve their peers there, so they narrow it. */
export const LoopbackHost = Context.Reference<(host: string) => boolean>(
  "t3/peer/PeerLinks/LoopbackHost",
  { defaultValue: () => isLocalLoopbackHost },
);

/** Whether a peer holds a linked agent to its limits and keeps its work within its link. */
const linkLimitsHold = (peer: { readonly capabilities: ExecutionEnvironmentCapabilities }) =>
  peer.capabilities.mcpModeLimitHeader === true && peer.capabilities.linkFence === true;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const ownOrigins = yield* OwnLinkOrigins.OwnLinkOrigins;
  const isOwnLoopback = yield* LoopbackHost;
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  /** A fresh name for one link's token; the row records it. */
  const newSecretName = random.randomBytes(16).pipe(
    Effect.map((bytes) => `peer-link-${Hex.encode(bytes)}`),
    Effect.orDie,
  );

  // Only the origin `peerOrigin` checked may receive a pairing code or token:
  // a redirect could forward them anywhere, including plain http.
  const peerHttpClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const clientFor = (origin: string) =>
    HttpApiClient.make(PeerHttpApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, peerHttpClient),
    );

  /** The environment answering at `origin`, or why nothing there answers as iglo.code. */
  const probe = (origin: string) => {
    const timeout = probeTimeout(origin);
    return clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      // A brief network drop must not list a live peer as down; the timeout still bounds both tries.
      Effect.retry({
        times: 1,
        schedule: Schedule.spaced("1 second"),
        while: (error) => certificateErrorCode(error) === undefined,
      }),
      Effect.timeout(timeout),
      // No cause: a decode error can carry the response body to the client.
      Effect.mapError((error) => probeFailure(origin, error, timeout)),
    );
  };

  /** Whether `url` answers as `environmentId`, counting any failure as no. */
  const answersAs = Effect.fn("PeerLinks.answersAs")(function* (
    url: string,
    environmentId: EnvironmentId,
  ) {
    const found = yield* probe(url).pipe(Effect.option);
    return Option.filter(found, (peer) => peer.environmentId === environmentId);
  });

  const toLink = Effect.fn("PeerLinks.toLink")(function* (row: PeerLinkRow) {
    return {
      environmentId: EnvironmentId.make(row.environment_id),
      label: row.label,
      // A row stored before https was preferred may still list the plain-http port beside it.
      urls: OwnLinkOrigins.preferHttps(yield* decodeUrls(row.urls_json)),
      access: yield* decodeAccess(row.access),
      linkedAt: DateTime.makeUnsafe(row.linked_at),
      // Its token predates link fencing, so the peer would not fence its work:
      // like an expired link, only a new pairing code brings it back.
      expiresAt: DateTime.makeUnsafe(row.fenced === 1 ? row.expires_at : row.linked_at),
      lastReachedAt: row.last_reached_at === null ? null : DateTime.makeUnsafe(row.last_reached_at),
      lastError: row.last_error,
    } satisfies PeerLink;
  }, Effect.catch(failStorage));

  const readRows = sql<PeerLinkRow>`
    SELECT * FROM peer_environment_links ORDER BY label, environment_id
  `.pipe(NodeSqliteClient.readOnly, Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<PeerLinkRow>`
      SELECT * FROM peer_environment_links WHERE environment_id = ${environmentId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  /** Signs in to the peer's `/mcp` with a pairing code: register, decide, exchange. */
  const signIn = Effect.fn("PeerLinks.signIn")(
    function* (
      origin: string,
      input: PeerLinkCreateInput,
      access: AuthMcpClientAccess,
      clientName: string,
      /** This environment's id, so the session it gets there names its owner. */
      environmentId: string,
    ) {
      const client = yield* clientFor(origin);
      // Only the peer's own refusals are rejections. A dropped connection or
      // an answer this version cannot read is classified below.
      const registered = yield* client.mcpOAuth
        .register({
          payload: {
            client_name: clientName,
            redirect_uris: [LINK_REDIRECT_URI],
            software_id: MCP_PEER_LINK_SOFTWARE_ID,
            software_version: environmentId,
          },
        })
        .pipe(
          // A plain Schema.Error has no tag to catch by.
          Effect.catchIf(Schema.is(AuthMcpRegistrationError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused to register this environment: ${error.message}`,
              }),
            ),
          ),
        );
      const verifier = Base64Url.encode(yield* random.randomBytes(32));
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(Effect.orDie),
      );
      const state = Base64Url.encode(yield* random.randomBytes(16));
      const resource = `${origin}/mcp`;
      const decided = yield* client.mcpOAuth
        .decision({
          headers: {},
          payload: {
            authorization: {
              response_type: "code",
              client_id: registered.client_id,
              redirect_uri: LINK_REDIRECT_URI,
              code_challenge: challenge,
              code_challenge_method: "S256",
              state: Redacted.make(state),
              resource,
            },
            decision: { _tag: "pairing-code", access, code: input.pairingCode },
          },
        })
        .pipe(
          Effect.catchTags({
            AuthMcpApprovalError: (error) =>
              Effect.fail(
                new PeerLinkError({ reason: "pairing_rejected", message: error.message }),
              ),
          }),
        );
      const redirect = URL.parse(decided.redirectTo);
      if (redirect === null) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${origin} answered the sign-in with an address this version cannot read. Update both environments.`,
        });
      }
      const code = redirect.searchParams.get("code");
      if (code === null || redirect.searchParams.get("state") !== state) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message:
            redirect.searchParams.get("error_description") ??
            "The peer did not approve the link. Check the pairing code and try again.",
        });
      }
      return yield* client.mcpOAuth
        .token({
          payload: {
            grant_type: "authorization_code",
            code: Redacted.make(code),
            redirect_uri: LINK_REDIRECT_URI,
            client_id: registered.client_id,
            code_verifier: Redacted.make(verifier),
            resource,
          },
        })
        .pipe(
          Effect.catchIf(Schema.is(AuthMcpTokenError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused the sign-in: ${error.message}`,
              }),
            ),
          ),
        );
    },
    (effect, origin) =>
      effect.pipe(
        // Endpoint errors are mapped above; what is left is the transport or an
        // answer this version cannot decode.
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "incompatible",
                message: `${origin} answered in a shape this version does not understand. Update both environments.`,
                cause,
              }),
            ),
          HttpClientError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "unreachable",
                message: `${origin} stopped answering while linking.`,
                cause,
              }),
            ),
        }),
      ),
  );

  /**
   * The addresses that answer as `environmentId`, in the order given, with
   * what the first one answered. Addresses this environment would not send
   * credentials to are skipped; when none answers as it, the failure says why
   * for each.
   */
  const answeringAs = Effect.fn("PeerLinks.answeringAs")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    name: string,
  ) {
    const checked = yield* Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const origin = yield* peerOrigin(url);
          // Loopback is this machine, where anything may answer as the one picked.
          if (isOwnLoopback(new URL(origin).hostname)) {
            return yield* new PeerLinkError({
              reason: "unreachable",
              message: `${origin} is this machine, not ${name}.`,
            });
          }
          const descriptor = yield* probe(origin);
          if (descriptor.environmentId !== environmentId) {
            return yield* new PeerLinkError({
              reason: "unreachable",
              message: `${origin} answered as another environment, ${descriptor.label}.`,
              answeredAs: descriptor.label,
            });
          }
          return { origin, descriptor };
        }).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const matching = checked.flatMap((result) =>
      Result.isSuccess(result) ? [result.success] : [],
    );
    const first = matching[0];
    if (first === undefined) {
      const failures = checked.flatMap((result) =>
        Result.isFailure(result) ? [result.failure] : [],
      );
      const answeredAs = failures.find((failure) => failure.answeredAs !== undefined)?.answeredAs;
      return yield* new PeerLinkError({
        reason: "unreachable",
        message: `This environment could not reach ${name}: ${failures.map((failure) => failure.message).join(" ")}`,
        ...(answeredAs === undefined ? {} : { answeredAs }),
      });
    }
    // Each address is kept once, even when two spellings share an origin. The caller
    // narrows what it stores; signing in goes to an https one whenever one answered.
    const origins = [...new Set(matching.map((found) => found.origin))];
    return { primary: OwnLinkOrigins.preferHttps(origins)[0]!, peer: first.descriptor, origins };
  });

  /** The peer at `url`, with every address checked for credentials first. */
  const answeringAt = Effect.fn("PeerLinks.answeringAt")(function* (urls: ReadonlyArray<string>) {
    const origins = OwnLinkOrigins.preferHttps(yield* Effect.forEach(urls, peerOrigin));
    const primary = origins[0]!;
    return { primary, peer: yield* probe(primary), origins };
  });

  /**
   * Offers the peer a one-time code minted here, so it links back to this
   * environment at the same access, over the session just signed in for. A
   * failed offer's code is revoked at once; a linked offer's grant id comes
   * back so this side can bind its row to the session the link back created.
   */
  const offerReciprocal = Effect.fn("PeerLinks.offerReciprocal")(function* (args: {
    readonly input: PeerLinkCreateInput;
    readonly peer: ExecutionEnvironmentDescriptor;
    readonly access: AuthMcpClientAccess;
    readonly primary: string;
    /** The token this environment just signed in with, which the peer knows. */
    readonly token: string;
  }): Effect.fn.Return<{
    readonly outcome: PeerLinkReciprocalOutcome;
    readonly grantId: string | undefined;
  }> {
    if (args.input.reciprocal !== true) return { outcome: { kind: "off" }, grantId: undefined };
    if (args.peer.capabilities.peerLinkReciprocal !== true) {
      return { outcome: { kind: "unsupported" }, grantId: undefined };
    }
    const self = yield* environment.getDescriptor;
    const origins = yield* ownOrigins.origins;
    if (origins.length === 0) {
      return {
        outcome: {
          kind: "failed",
          message:
            "This machine has no Tailscale address the peer could link back over. Publish one with `iglo.code pair --tailscale`, or link back from there by hand.",
        },
        grantId: undefined,
      };
    }
    const minted = yield* environmentAuth
      .issuePairingCredential({
        access: args.access,
        purpose: "peer-link",
        label: `Link back to ${self.label}`,
      })
      .pipe(Effect.result);
    if (Result.isFailure(minted)) {
      return {
        outcome: {
          kind: "failed",
          message: reciprocalOfferFailure(args.peer.label, minted.failure),
        },
        grantId: undefined,
      };
    }
    const grant = minted.success;
    return yield* Effect.gen(function* () {
      const client = yield* clientFor(args.primary);
      const outcome = yield* client.peerLinks
        .reciprocal({
          headers: { authorization: `Bearer ${args.token}` },
          payload: {
            environmentId: self.environmentId,
            label: self.label,
            urls: origins as [string, ...string[]],
            pairingCode: grant.credential,
            access: args.access,
          },
        })
        .pipe(
          Effect.timeout(RECIPROCAL_OFFER_TIMEOUT),
          Effect.as({ kind: "linked" } as const),
          Effect.catch((error) =>
            Effect.succeed<PeerLinkReciprocalOutcome>({
              kind: "failed",
              message: reciprocalOfferFailure(args.peer.label, error),
            }),
          ),
        );
      return { outcome, grantId: outcome.kind === "linked" ? grant.id : undefined };
    }).pipe(
      // A code that never linked back — failed or interrupted — must not stay
      // live for its whole lifetime.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && exit.value.outcome.kind === "linked"
          ? Effect.void
          : environmentAuth.revokePairingLink(grant.id).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.annotateLogs({ "peer_link.peer": args.peer.environmentId }),
    );
  });

  interface LinkOptions {
    /**
     * Set when a linked peer's offer is being accepted. The accept path never
     * moves or replaces a link this environment already holds, expired or not:
     * only the offer's own addresses may renew it.
     */
    readonly fromReciprocalOffer?: boolean;
    /** The session the offer arrived over, bound to the row this link creates. */
    readonly bindSessionId?: AuthSessionId;
    /** Set by linkUnlessLinked: a machine whose link has not expired is kept and checked. */
    readonly keepLinked?: boolean;
    /**
     * The access the link has. Every link made here is full access; only an accepted offer
     * takes the access its sender minted the code at, so an older peer's lower offer still links.
     */
    readonly access?: AuthMcpClientAccess;
  }

  const linkImpl = Effect.fn("PeerLinks.linkImpl")(function* (
    input: PeerLinkCreateInput,
    options: LinkOptions = {},
  ) {
    const access = options.access ?? "full-access";
    if (!(yield* enabled)) {
      return yield* new PeerLinkError({ reason: "disabled", message: LINKED_ENVIRONMENTS_OFF });
    }
    const urls = [input.url, ...(input.alternateUrls ?? [])];
    // The user picked a machine: link through the addresses that answer as
    // it, so one that now answers as another never receives the pairing code.
    let { primary, peer, origins } =
      input.expectedEnvironmentId === undefined
        ? yield* answeringAt(urls)
        : yield* answeringAs(
            urls,
            input.expectedEnvironmentId,
            input.expectedLabel ?? input.expectedEnvironmentId,
          );
    // Anything can answer as a linked machine, so an address alone renews its
    // link only where the link already reaches it, and never moves it. An
    // accepted offer is stricter still: it may not touch a link at another
    // address even when that link has expired.
    const existingRow = yield* readRow(peer.environmentId);
    const existing = Option.isSome(existingRow) ? yield* toLink(existingRow.value) : undefined;
    const current =
      existing !== undefined && DateTime.isGreaterThan(existing.expiresAt, yield* DateTime.now)
        ? existing
        : undefined;
    if (options.keepLinked === true && current !== undefined) {
      // Linking again trades both sides' current addresses, so a link made while one was
      // not ready yet picks it up. Addresses given here alone never join a held link.
      const checked = yield* check(current.environmentId).pipe(Effect.option);
      // A peer that answered and refused the link (revoked there, say) is linked again
      // with the code given, which is what its recorded error asks for.
      const refused =
        Option.isSome(checked) &&
        checked.value.status === "reachable" &&
        checked.value.lastError !== null;
      if (!refused) {
        const { status, ...refreshed } = Option.getOrElse(checked, () => ({
          ...current,
          status: "unreachable" as const,
        }));
        return {
          link: refreshed,
          reciprocal: { kind: "off" } as const,
          alreadyLinked: true,
          status,
        };
      }
    }
    if (existing !== undefined && options.fromReciprocalOffer === true) {
      // A renewal from the accepting side signs in where the row already
      // reaches: the peer's own addresses can come in another order, so the
      // first offered one the row holds wins, and the row keeps its addresses.
      const known = origins.filter((origin) => existing.urls.includes(origin));
      if (known.length === 0) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message: `${primary} answers as ${existing.label}, which is already linked at another address. If ${existing.label} moved, forget that link first.`,
        });
      }
      primary = known[0]!;
      origins = [...existing.urls];
    } else if (existing !== undefined && !existing.urls.includes(primary)) {
      const guarded =
        input.expectedEnvironmentId === undefined &&
        DateTime.isGreaterThan(existing.expiresAt, yield* DateTime.now);
      if (guarded) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message: `${primary} answers as ${existing.label}, which is already linked at another address. If ${existing.label} moved, forget that link first.`,
        });
      }
    }
    const self = yield* environment.getDescriptor;
    if (peer.environmentId === self.environmentId) {
      return yield* new PeerLinkError({
        reason: "self",
        message: "That address is this environment.",
      });
    }
    if (!linkLimitsHold(peer)) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${peer.label} runs an iglo.code version that cannot keep a linked agent's limits. Update it, then link again.`,
      });
    }
    const issued = yield* signIn(
      primary,
      input,
      access,
      `${LINK_CLIENT_NAME_PREFIX}${self.label}`,
      self.environmentId,
    );
    const now = yield* DateTime.now;
    const linked: PeerLink = {
      environmentId: peer.environmentId,
      label: peer.label,
      urls: OwnLinkOrigins.preferHttps(origins),
      access,
      linkedAt: now,
      expiresAt: DateTime.add(now, { seconds: issued.expires_in }),
      lastReachedAt: now,
      lastError: null,
    };
    // The token goes under a name of its own before the row points at it,
    // so the row and its token are replaced together.
    const secretName = yield* newSecretName;
    yield* secrets
      .set(secretName, new TextEncoder().encode(issued.access_token))
      .pipe(Effect.catch(failStorage));
    // A token no row names could never be removed.
    const previous = yield* Effect.gen(function* () {
      const urlsJson = yield* encodeUrls(linked.urls).pipe(Effect.catch(failStorage));
      const previous = yield* readRow(peer.environmentId);
      if (options.fromReciprocalOffer === true) {
        // The guard read `existingRow` before signing in, which can take as
        // long as the peer wants; the write is conditional on that row, not a
        // fresh read, so a row appearing in the gap is never overwritten.
        const written = Option.isSome(existingRow)
          ? yield* sql<{ readonly one: number }>`
              UPDATE peer_environment_links SET
                secret_name = ${secretName},
                fenced = 1,
                label = ${linked.label},
                urls_json = ${urlsJson},
                access = ${linked.access},
                linked_at = ${DateTime.formatIso(linked.linkedAt)},
                expires_at = ${DateTime.formatIso(linked.expiresAt)},
                last_reached_at = ${DateTime.formatIso(now)},
                last_error = NULL,
                peer_session_id = ${options.bindSessionId ?? null}
              WHERE environment_id = ${linked.environmentId}
                AND secret_name = ${existingRow.value.secret_name}
              RETURNING 1 AS one
            `.pipe(Effect.catch(failStorage))
          : yield* sql<{ readonly one: number }>`
              INSERT INTO peer_environment_links (
                environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
                last_reached_at, last_error, fenced, peer_session_id
              ) VALUES (
                ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
                ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
                ${DateTime.formatIso(now)}, NULL, 1, ${options.bindSessionId ?? null}
              )
              ON CONFLICT (environment_id) DO NOTHING
              RETURNING 1 AS one
            `.pipe(Effect.catch(failStorage));
        if (written.length === 0) {
          return yield* new PeerLinkError({
            reason: "pairing_rejected",
            message: `${primary} answers as ${peer.label}, which linked meanwhile at another address. Forget that link first.`,
          });
        }
        // The conditional write replaced exactly the row the guard saw, so the
        // old token is the guard's, not whatever a fresh read shows now.
        return existingRow;
      }
      // A plain renewal carries no session to bind, so the old binding stays.
      yield* sql`
        INSERT INTO peer_environment_links (
          environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
          last_reached_at, last_error, fenced, peer_session_id
        ) VALUES (
          ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
          ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
          ${DateTime.formatIso(now)}, NULL, 1, ${options.bindSessionId ?? null}
        )
        ON CONFLICT (environment_id) DO UPDATE SET
          secret_name = excluded.secret_name,
          fenced = excluded.fenced,
          label = excluded.label,
          urls_json = excluded.urls_json,
          access = excluded.access,
          linked_at = excluded.linked_at,
          expires_at = excluded.expires_at,
          last_reached_at = excluded.last_reached_at,
          last_error = NULL,
          peer_session_id = COALESCE(excluded.peer_session_id, peer_environment_links.peer_session_id)
      `.pipe(Effect.catch(failStorage));
      return previous;
    }).pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
    // Linking again replaces the old token. A racing link may leave its own
    // behind; it is unused either way.
    if (Option.isSome(previous) && previous.value.secret_name !== secretName) {
      yield* secrets.remove(previous.value.secret_name).pipe(Effect.ignore);
    }
    const offer = yield* offerReciprocal({
      input,
      peer,
      access,
      primary,
      token: issued.access_token,
    });
    // When the peer linked back, bind this row to the session that link back
    // created here, so a later teardown can tell it is the link's own. Best
    // effort: an unbound row still works, its teardown just degrades to kept.
    if (offer.outcome.kind === "linked" && offer.grantId !== undefined) {
      yield* Effect.gen(function* () {
        const rows = yield* sql<{ session_id: string }>`
          SELECT session_id FROM auth_sessions WHERE pairing_grant_id = ${offer.grantId}
          ORDER BY issued_at DESC LIMIT 1
        `.pipe(NodeSqliteClient.readOnly);
        const sessionId = rows[0]?.session_id;
        if (sessionId !== undefined) {
          yield* sql`
            UPDATE peer_environment_links SET peer_session_id = ${sessionId}
            WHERE environment_id = ${linked.environmentId}
              AND secret_name = ${secretName}
          `;
        }
      }).pipe(Effect.ignoreCause({ log: true }));
    }
    return { link: linked, reciprocal: offer.outcome, alreadyLinked: false };
  });

  /** The public link: a flat link with what came of linking back. */
  const link: PeerLinks["Service"]["link"] = (input) =>
    Effect.map(linkImpl(input), ({ link: linked, reciprocal }) => ({ ...linked, reciprocal }));
  /** Links like `link`, except a machine whose link has not expired is kept and checked. */
  const linkUnlessLinked: PeerLinks["Service"]["linkUnlessLinked"] = (input) =>
    Effect.map(
      linkImpl(input, { keepLinked: true }),
      ({ link: linked, reciprocal, alreadyLinked, ...rest }) => ({
        link: linked,
        reciprocal,
        alreadyLinked,
        ...("status" in rest && rest.status !== undefined ? { status: rest.status } : {}),
      }),
    );

  /** A peer's label follows its machine name, so the link takes the one its own address answers with. */
  const withLabel = (link: PeerLink, label: string) =>
    label === link.label
      ? Effect.succeed(link)
      : sql`
          UPDATE peer_environment_links SET label = ${label}
          WHERE environment_id = ${link.environmentId}
        `.pipe(Effect.ignoreCause({ log: true }), Effect.as({ ...link, label }));

  const statusOf = Effect.fn("PeerLinks.statusOf")(function* (
    link: PeerLink,
    now: DateTime.Utc,
  ): Effect.fn.Return<PeerLinkSummary> {
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, now)) return { ...link, status: "expired" };
    // A race over no addresses never settles.
    if (link.urls.length === 0) return { ...link, status: "unreachable" };
    const answered = yield* Effect.raceAll(
      link.urls.map((url) =>
        answersAs(url, link.environmentId).pipe(Effect.flatMap(Effect.fromOption)),
      ),
    ).pipe(Effect.timeoutOption(LIST_PROBE_TIMEOUT), Effect.orElseSucceed(Option.none));
    if (Option.isNone(answered)) return { ...link, status: "unreachable" };
    return { ...(yield* withLabel(link, answered.value.label)), status: "reachable" };
  });

  const list: PeerLinks["Service"]["list"] = Effect.gen(function* () {
    const links = yield* Effect.forEach(yield* readRows, toLink);
    const now = yield* DateTime.now;
    return yield* Effect.forEach(links, (link) => statusOf(link, now), {
      concurrency: "unbounded",
    });
  });

  const names: PeerLinks["Service"]["names"] = Effect.gen(function* () {
    const links = yield* Effect.forEach(yield* readRows, toLink);
    const now = yield* DateTime.now;
    return links.flatMap((link) =>
      DateTime.isGreaterThan(link.expiresAt, now)
        ? [{ environmentId: link.environmentId, label: link.label }]
        : [],
    );
  });

  const get: PeerLinks["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(toLink(row)),
        }),
      ),
    );

  /** Deletes the link's row and its token here. Returns whether a link went. */
  const removeLinkRow = (environmentId: EnvironmentId) =>
    sql<{ secret_name: string }>`
      DELETE FROM peer_environment_links WHERE environment_id = ${environmentId}
      RETURNING secret_name
    `.pipe(
      Effect.catch(failStorage),
      Effect.flatMap((deleted) =>
        Effect.forEach(
          deleted,
          (row) => secrets.remove(row.secret_name).pipe(Effect.catch(failStorage)),
          {
            discard: true,
          },
        ).pipe(Effect.as(deleted.length > 0)),
      ),
    );

  /** Asks the peer to forget its link back here, over an address that still answers as it. */
  const teardownAt = Effect.fn("PeerLinks.teardownAt")(function* (args: {
    /** This environment's id, which the peer's link back names. */
    readonly environmentId: EnvironmentId;
    readonly url: string;
    readonly token: string;
    readonly label: string;
    /** This environment's own label, as the peer names the session this side holds there. */
    readonly selfLabel: string;
    /**
     * Set on the hop a teardown makes back: there, an auth-invalid answer means
     * the session is already ended, which is all the hop exists to do.
     */
    readonly hopBack?: boolean;
  }): Effect.fn.Return<PeerLinkTeardownOutcome> {
    return yield* clientFor(args.url).pipe(
      Effect.flatMap((client) =>
        client.peerLinks.teardown({
          headers: { authorization: `Bearer ${args.token}` },
          payload: { environmentId: args.environmentId },
        }),
      ),
      Effect.timeout(args.hopBack === true ? TEARDOWN_HOP_TIMEOUT : TEARDOWN_TIMEOUT),
      Effect.map((result): PeerLinkTeardownOutcome =>
        // A peer that never linked back has no link to keep, so from here the
        // link back is as good as gone.
        result.removed || !result.kept
          ? { kind: "removed" }
          : {
              kind: "kept",
              message: `${args.label} kept its link back here. Revoke "iglo.code · ${args.label}" in this machine's Sharing & access to end its session here.`,
            },
      ),
      Effect.catch((error) =>
        Effect.succeed<PeerLinkTeardownOutcome>(
          args.hopBack === true && (isAuthInvalid(error) || isHttpForbidden(error))
            ? { kind: "removed" }
            : {
                kind: "off",
                message: teardownFailure(args.label, args.selfLabel, error),
              },
        ),
      ),
      Effect.annotateLogs({ "peer_link.peer": args.environmentId }),
    );
  });

  /** Where the link's peer still answers as itself, racing the addresses it was linked at. */
  const answeringLinkAt = (link: PeerLink) =>
    link.urls.length === 0
      ? Effect.succeedNone
      : Effect.raceAll(
          link.urls.map((url) =>
            answersAs(url, link.environmentId).pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.map((peer) => ({ url, peer })),
            ),
          ),
        ).pipe(Effect.option);

  /** Ends this side's session at a peer too old to forget a link; RFC 7009 answers 200 either way. */
  const revokeAt = (url: string, token: string) =>
    clientFor(url).pipe(
      Effect.flatMap((client) =>
        client.mcpOAuth
          .revoke({ payload: { token: Redacted.make(token) } })
          .pipe(Effect.timeout(probeTimeout(url))),
      ),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logDebug("The unlinked peer did not revoke the link's session", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const unlink: PeerLinks["Service"]["unlink"] = Effect.fn("PeerLinks.unlink")(
    function* (environmentId) {
      const row = yield* readRow(environmentId);
      if (Option.isNone(row)) return { removed: false, endedThere: false };
      const link = yield* toLink(row.value);
      const self = yield* environment.getDescriptor;
      const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
      // The teardown token goes only to an address that still answers as the
      // peer, as the token for a call does. The link is forgotten here
      // whatever the peer then says.
      const answered = Option.isSome(stored) ? yield* answeringLinkAt(link) : Option.none();
      const removed = yield* removeLinkRow(environmentId);
      // The peer's session here was bound to this row, so it ends with it,
      // whether or not the peer can be asked.
      if (removed && row.value.peer_session_id !== null) {
        yield* environmentAuth
          .revokeSession(AuthSessionId.make(row.value.peer_session_id))
          .pipe(Effect.ignoreCause({ log: true }));
      }
      if (!removed) return { removed: false, endedThere: false };
      if (Option.isNone(stored)) {
        // This side held no token, so it never asked the peer anything.
        return {
          removed: true,
          endedThere: false,
          remote: {
            kind: "off",
            message: `${link.label} was not asked: forget its link back there, in its Connections.`,
          } satisfies PeerLinkTeardownOutcome,
        };
      }
      if (Option.isNone(answered)) {
        return {
          removed: true,
          endedThere: false,
          remote: {
            kind: "off",
            message: `${link.label} did not answer. Forget its link there, in its Connections, and revoke "iglo.code · ${self.label}" in ${link.label}'s Sharing & access to end this side's session there.`,
          } satisfies PeerLinkTeardownOutcome,
        };
      }
      const token = new TextDecoder().decode(stored.value);
      // An older peer has no teardown endpoint, but may still revoke the token it issued.
      if (answered.value.peer.capabilities.peerLinkReciprocal !== true) {
        const endedThere = yield* revokeAt(answered.value.url, token);
        return {
          removed: true,
          endedThere,
          remote: {
            kind: "off",
            message: endedThere
              ? `${link.label} ended this side's session there, but runs an iglo.code version that cannot forget a link from here. Forget its link back in its Connections.`
              : `${link.label} runs an iglo.code version that cannot forget a link from here. Revoke "iglo.code · ${self.label}" in ${link.label}'s Sharing & access to end this side's session there.`,
          } satisfies PeerLinkTeardownOutcome,
        };
      }
      const remote = yield* teardownAt({
        environmentId: self.environmentId,
        url: answered.value.url,
        token,
        label: link.label,
        selfLabel: self.label,
      });
      // A teardown that reached the peer ends the session it came over, kept link or not.
      return { removed: true, endedThere: remote.kind !== "off", remote };
    },
  );

  const acceptReciprocal: PeerLinks["Service"]["acceptReciprocal"] = Effect.fn(
    "PeerLinks.acceptReciprocal",
  )(function* (caller, offer) {
    // The session is the offer's credential, and it names one environment.
    if (
      caller.peerEnvironmentId === undefined ||
      caller.peerEnvironmentId !== offer.environmentId
    ) {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message:
          "That session belongs to another environment, so it may not offer this one's link.",
      });
    }
    const [url, ...alternateUrls] = offer.urls;
    return yield* linkImpl(
      {
        url,
        ...(alternateUrls.length === 0 ? {} : { alternateUrls }),
        pairingCode: offer.pairingCode,
        expectedEnvironmentId: offer.environmentId,
        expectedLabel: offer.label,
        // The link being made is the offer's answer; offering back would loop.
        reciprocal: false,
      },
      // The row this accept creates is bound to the offering session, and the
      // accept path never moves a link this environment already holds.
      { fromReciprocalOffer: true, bindSessionId: caller.sessionId, access: offer.access },
    ).pipe(
      Effect.map((created) => created.link),
      // Per-address probe results must not echo back to the caller: they would
      // turn the offer into a port scanner. The detail stays in this log.
      Effect.tapError((error) =>
        Effect.logWarning("A reciprocal offer failed.", {
          environmentId: offer.environmentId,
          reason: error.reason,
          message: error.message,
        }),
      ),
      Effect.mapError((error) =>
        error.reason === "unreachable" || error.reason === "not_a_t3_environment"
          ? new PeerLinkError({
              reason: error.reason,
              message: "The offered addresses did not answer as that environment.",
              cause: error.cause,
            })
          : error,
      ),
    );
  });

  const forgetPeer: PeerLinks["Service"]["forgetPeer"] = Effect.fn("PeerLinks.forgetPeer")(
    function* (caller, environmentId) {
      // The relationship ends with the session the request came over, whether
      // or not a link back is left to remove.
      const revokeCaller = environmentAuth
        .revokeSession(caller.sessionId)
        .pipe(Effect.ignoreCause({ log: true }));
      const row = yield* readRow(environmentId);
      // A session from before this change declared no id. No reciprocal offer
      // could have come over it, so no row back is its to remove; its session
      // still ends, which is all that link has left.
      if (caller.peerEnvironmentId === undefined) {
        yield* revokeCaller;
        return { removed: false, kept: Option.isSome(row) };
      }
      if (caller.peerEnvironmentId !== environmentId) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message:
            "That session belongs to another environment, so it may not forget this one's link.",
        });
      }
      if (Option.isNone(row)) {
        yield* revokeCaller;
        return { removed: false, kept: false };
      }
      // Only the session this row is bound to may forget it. A linked peer
      // claiming another environment's id pays with its own session, which is
      // revoked either way, and nothing more.
      if (row.value.peer_session_id !== caller.sessionId) {
        yield* revokeCaller;
        yield* Effect.logWarning("A peer-link session tried to forget a link it is not bound to.", {
          environmentId,
          sessionId: caller.sessionId,
        });
        return { removed: false, kept: true };
      }
      const link = yield* toLink(row.value);
      const self = yield* environment.getDescriptor;
      const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
      const answered = Option.isSome(stored) ? yield* answeringLinkAt(link) : Option.none();
      // The row was read before the probe, which can take seconds; delete only
      // the row this session is still bound to, so one re-linked in the gap
      // survives with its token.
      const removed = yield* sql<{ secret_name: string }>`
        DELETE FROM peer_environment_links
        WHERE environment_id = ${environmentId} AND peer_session_id = ${caller.sessionId}
        RETURNING secret_name
      `.pipe(
        Effect.catch(failStorage),
        Effect.flatMap((deleted) =>
          Effect.forEach(
            deleted,
            (deletedRow) => secrets.remove(deletedRow.secret_name).pipe(Effect.catch(failStorage)),
            { discard: true },
          ).pipe(Effect.as(deleted.length > 0)),
        ),
      );
      yield* revokeCaller;
      if (!removed) {
        return { removed: false, kept: Option.isSome(yield* readRow(environmentId)) };
      }
      // One hop each way ends both halves: the peer forgets its link here and
      // ends the session this side's link holds there. Its own teardown finds
      // no row left, so the hops stop. The hop is best-effort: when it cannot
      // reach, the session it would have ended stays an inert row there.
      if (Option.isSome(stored) && Option.isSome(answered)) {
        const remote = yield* teardownAt({
          environmentId: self.environmentId,
          url: answered.value.url,
          token: new TextDecoder().decode(stored.value),
          label: link.label,
          selfLabel: self.label,
          hopBack: true,
        });
        if (remote.kind === "off") {
          yield* Effect.logWarning("A peer's teardown hop back could not end its session here.", {
            environmentId,
            reason: remote.message,
          });
        }
      }
      return { removed, kept: false };
    },
  );

  const resolve: PeerLinks["Service"]["resolve"] = Effect.fn("PeerLinks.resolve")(
    function* (environmentId) {
      const notLinked = new PeerLinkError({
        reason: "unknown_link",
        message: `This environment is not linked to ${environmentId}. t3_environment_links lists the linked ones.`,
      });
      const row = yield* readRow(environmentId);
      if (Option.isNone(row)) return yield* notLinked;
      const link = yield* toLink(row.value);
      if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
        return yield* new PeerLinkError({
          reason: "expired",
          message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
        });
      }
      const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
      if (Option.isNone(stored)) {
        // An unlink between the two reads removes the row before its secret.
        if (Option.isNone(yield* readRow(environmentId))) return yield* notLinked;
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `The link to ${link.label} lost its credential. Link it again.`,
        });
      }
      // The token goes only to an address that still answers as this peer,
      // so one that now answers as another machine never receives it. The
      // addresses race, so a silent one never delays one that answers.
      const answered =
        link.urls.length === 0
          ? Option.none()
          : yield* Effect.raceAll(
              link.urls.map((url) =>
                answersAs(url, environmentId).pipe(
                  Effect.flatMap(Effect.fromOption),
                  Effect.map((peer) => ({ url, peer })),
                ),
              ),
            ).pipe(Effect.option);
      if (Option.isNone(answered)) {
        return yield* new PeerLinkError({
          reason: "unreachable",
          message: `${link.label} did not answer at ${link.urls.join(", ")}.`,
        });
      }
      const { url, peer } = answered.value;
      // A link made before the peer had to fence linked work, or a peer moved
      // back to such a version, would carry work past those limits.
      if (!linkLimitsHold(peer)) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} runs an iglo.code version that cannot keep a linked agent's limits. Update it, then link again.`,
        });
      }
      return {
        link: yield* withLabel(link, peer.label),
        url,
        token: new TextDecoder().decode(stored.value),
        capabilities: peer.capabilities,
      };
    },
  );

  /**
   * Adds the addresses among `offered` that answer as the linked peer to its row. It never
   * drops or reorders one the row holds, and writes only over the row it read, so a link
   * made again meanwhile keeps its own. With `boundTo`, only a row bound to that session
   * takes them: the session is the claim to speak for the peer.
   */
  const mergeOrigins = Effect.fn("PeerLinks.mergeOrigins")(function* (
    environmentId: EnvironmentId,
    offered: ReadonlyArray<string>,
    boundTo?: AuthSessionId,
  ) {
    const row = yield* readRow(environmentId);
    if (Option.isNone(row)) return;
    if (boundTo !== undefined && row.value.peer_session_id !== boundTo) return;
    const link = yield* toLink(row.value);
    const room = MAX_LINK_URLS - link.urls.length;
    // A link with an https address takes no plain-http one; it would only be dropped again.
    const httpsOnly = link.urls.some((url) => url.startsWith("https:"));
    const candidates = new Set<string>();
    for (const url of room > 0 ? offered.slice(0, MAX_RECIPROCAL_OFFER_URLS) : []) {
      const origin = yield* peerOrigin(url).pipe(Effect.option);
      if (Option.isNone(origin) || link.urls.includes(origin.value)) continue;
      const parsed = new URL(origin.value);
      const host = parsed.hostname;
      if (httpsOnly && parsed.protocol === "http:" && !isLocalLoopbackHost(host)) continue;
      // Only tailnet names, which is all a peer offers: an announced public host would
      // otherwise join the row for good. Loopback that is not this machine's is a test peer.
      if (isTailnetHost(host) || (isLocalLoopbackHost(host) && !isOwnLoopback(host))) {
        candidates.add(origin.value);
      }
    }
    const answering = yield* Effect.forEach(
      [...candidates],
      (origin) =>
        answersAs(origin, environmentId).pipe(
          Effect.map((found) => (Option.isSome(found) ? [origin] : [])),
        ),
      { concurrency: "unbounded" },
    );
    const added = answering.flat().slice(0, Math.max(room, 0));
    // An https address that answers retires the plain-http ones, and a row stored with
    // both is rewritten here even when nothing new answers.
    const urlsJson = yield* encodeUrls(OwnLinkOrigins.preferHttps([...link.urls, ...added])).pipe(
      Effect.catch(failStorage),
    );
    if (urlsJson === row.value.urls_json) return;
    const written = yield* sql<{ readonly one: number }>`
      UPDATE peer_environment_links SET urls_json = ${urlsJson}
      WHERE environment_id = ${environmentId}
        AND secret_name = ${row.value.secret_name}
        AND urls_json = ${row.value.urls_json}
      RETURNING 1 AS one
    `.pipe(Effect.catch(failStorage));
    if (written.length === 0 || added.length === 0) return;
    yield* Effect.logInfo("A linked environment answers at new addresses.", {
      environmentId,
      added,
    });
  });

  const exchangeOrigins: PeerLinks["Service"]["exchangeOrigins"] = Effect.fn(
    "PeerLinks.exchangeOrigins",
  )(function* (caller, offer) {
    if (!(yield* enabled)) {
      return yield* new PeerLinkError({ reason: "disabled", message: LINKED_ENVIRONMENTS_OFF });
    }
    if (
      caller.peerEnvironmentId === undefined ||
      caller.peerEnvironmentId !== offer.environmentId
    ) {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message:
          "That session belongs to another environment, so it may not name this one's addresses.",
      });
    }
    // What came of the offered addresses stays here: echoing it would make the call a scanner.
    const [, urls] = yield* Effect.all(
      [
        mergeOrigins(offer.environmentId, offer.urls, caller.sessionId).pipe(
          Effect.ignoreCause({ log: true }),
        ),
        ownOrigins.origins,
      ],
      { concurrency: "unbounded" },
    );
    return { urls: urls.slice(0, MAX_RECIPROCAL_OFFER_URLS) };
  });

  /** Why the peer refused a check, in words a user can act on; none when it just did not answer. */
  const checkFailure = (label: string, error: unknown): string | null => {
    if (isAuthInvalid(error) || isHttpForbidden(error)) {
      return `${label} no longer accepts this link. It may have been revoked there; link it again.`;
    }
    if (isPeerLinkReciprocalError(error)) {
      return error.reason === "disabled"
        ? `Linked environments is off on ${label}. Turn it on there in Settings → Labs.`
        : `${label} refused the check: ${error.message}`;
    }
    if (Cause.isTimeoutError(error)) return null;
    if (HttpClientError.isHttpClientError(error)) {
      return error.reason._tag === "TransportError"
        ? null
        : `${label} answered the check with an error.`;
    }
    return `${label} answered in a shape this version does not understand. Update both environments.`;
  };

  const check: PeerLinks["Service"]["check"] = Effect.fn("PeerLinks.check")(
    function* (environmentId) {
      if (!(yield* enabled)) {
        return yield* new PeerLinkError({ reason: "disabled", message: LINKED_ENVIRONMENTS_OFF });
      }
      const before = yield* get(environmentId);
      if (Option.isNone(before)) {
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `This environment is not linked to ${environmentId}.`,
        });
      }
      const listed = (status: PeerLinkSummary["status"]) =>
        get(environmentId).pipe(
          Effect.map((current) => ({ ...Option.getOrElse(current, () => before.value), status })),
        );
      if (DateTime.isLessThanOrEqualTo(before.value.expiresAt, yield* DateTime.now)) {
        return { ...before.value, status: "expired" as const };
      }
      const resolved = yield* resolve(environmentId).pipe(Effect.result);
      if (Result.isFailure(resolved)) {
        if (resolved.failure.reason === "unreachable") return yield* listed("unreachable");
        // It answered, but the link cannot be used as it stands.
        yield* recordOutcome(environmentId, { error: resolved.failure.message });
        return yield* listed(resolved.failure.reason === "expired" ? "expired" : "reachable");
      }
      const { link, url, token } = resolved.success;
      const self = yield* environment.getDescriptor;
      const urls = yield* ownOrigins.origins;
      const answer = yield* clientFor(url).pipe(
        Effect.flatMap((client) =>
          client.peerLinks.origins({
            headers: { authorization: `Bearer ${token}` },
            payload: {
              environmentId: self.environmentId,
              urls: urls.slice(0, MAX_RECIPROCAL_OFFER_URLS),
            },
          }),
        ),
        Effect.timeout(ORIGINS_EXCHANGE_TIMEOUT),
        Effect.result,
        Effect.annotateLogs({ "peer_link.peer": environmentId }),
      );
      if (Result.isSuccess(answer)) {
        yield* recordOutcome(environmentId, { error: null });
        yield* mergeOrigins(environmentId, answer.success.urls).pipe(
          Effect.ignoreCause({ log: true }),
        );
        return yield* listed("reachable");
      }
      const error = answer.failure;
      // A peer from before this check answers 404: it answered, but its token is not checked.
      if (HttpClientError.isHttpClientError(error) && missingEndpoint(error)) {
        return yield* listed("reachable");
      }
      const message = checkFailure(link.label, error);
      if (message === null) return yield* listed("unreachable");
      yield* recordOutcome(environmentId, { error: message });
      return yield* listed("reachable");
    },
  );

  const recordOutcome: PeerLinks["Service"]["recordOutcome"] = (environmentId, outcome) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        outcome.error === null
          ? sql`
              UPDATE peer_environment_links
              SET last_reached_at = ${DateTime.formatIso(now)}, last_error = NULL
              WHERE environment_id = ${environmentId}
            `
          : sql`
              UPDATE peer_environment_links SET last_error = ${outcome.error}
              WHERE environment_id = ${environmentId}
            `,
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
    );

  const recordExpiry: PeerLinks["Service"]["recordExpiry"] = (environmentId, expiresAt) =>
    sql`
      UPDATE peer_environment_links SET expires_at = ${DateTime.formatIso(expiresAt)}
      WHERE environment_id = ${environmentId} AND expires_at < ${DateTime.formatIso(expiresAt)}
    `.pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));

  return PeerLinks.of({
    enabled,
    link,
    linkUnlessLinked,
    list,
    names,
    get,
    unlink,
    acceptReciprocal,
    forgetPeer,
    resolve,
    check,
    exchangeOrigins,
    recordOutcome,
    recordExpiry,
  });
});

export const layer = Layer.effect(PeerLinks, make);
