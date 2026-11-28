/**
 * Reciprocal peer links, called over a peer's link session by the other
 * environment's server. Only a linked peer's session may call: a regular
 * MCP client is refused, and the session names the environment it may offer
 * or forget, so one linked peer cannot act for another.
 */
import {
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  PeerLinkAuthenticated,
  PeerLinkError,
  PeerLinkPrincipal,
  PeerLinkReciprocalError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../auth/http.ts";
import * as PeerLinks from "./PeerLinks.ts";

const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

const failAuthInvalid = (reason: EnvironmentAuthInvalidReason) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId })),
    ),
  );

/** PeerLinkError as the reciprocal endpoints answer it, over plain http. */
const toReciprocalError = (error: PeerLinkError) => {
  const reasons = [
    "disabled",
    "unreachable",
    "not_a_t3_environment",
    "incompatible",
    "self",
    "pairing_rejected",
    "storage",
  ] as const;
  type Reason = (typeof reasons)[number];
  const reason = reasons.includes(error.reason as Reason)
    ? (error.reason as Reason)
    : "pairing_rejected";
  return new PeerLinkReciprocalError({ reason, message: error.message });
};

export const layerPeerLinkAuthenticated = Layer.effect(
  PeerLinkAuthenticated,
  Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const client = yield* environmentAuth
          .authenticateMcpClient(yield* HttpServerRequest.HttpServerRequest)
          .pipe(
            Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
              failAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
            ),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
              Effect.logWarning("Peer link session check failed.", { cause: error }).pipe(
                Effect.andThen(failAuthInvalid("invalid_credential")),
              ),
            ),
          );
        if (!client.peerLink) {
          return yield* new EnvironmentHttpForbiddenError({
            message: "Only another environment's peer link may call here.",
          });
        }
        return yield* httpEffect.pipe(
          Effect.provideService(PeerLinkPrincipal, {
            sessionId: client.sessionId,
            label: client.label,
            peerEnvironmentId: client.peerEnvironmentId,
          }),
        );
      });
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "peerLinks",
  Effect.fn("environment.peerLinks")(function* (handlers) {
    const peerLinks = yield* PeerLinks.PeerLinks;
    return handlers
      .handle(
        "reciprocal",
        Effect.fn("environment.peerLinks.reciprocal")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* PeerLinkPrincipal;
          return yield* peerLinks
            .acceptReciprocal(principal, args.payload)
            .pipe(
              Effect.mapError(toReciprocalError),
              Effect.annotateLogs({ "peer_link.peer": args.payload.environmentId }),
            );
        }),
      )
      .handle(
        "origins",
        Effect.fn("environment.peerLinks.origins")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* PeerLinkPrincipal;
          return yield* peerLinks
            .exchangeOrigins(principal, args.payload)
            .pipe(
              Effect.mapError(toReciprocalError),
              Effect.annotateLogs({ "peer_link.peer": args.payload.environmentId }),
            );
        }),
      )
      .handle(
        "teardown",
        Effect.fn("environment.peerLinks.teardown")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* PeerLinkPrincipal;
          return yield* peerLinks
            .forgetPeer(principal, args.payload.environmentId)
            .pipe(
              Effect.mapError(toReciprocalError),
              Effect.annotateLogs({ "peer_link.peer": args.payload.environmentId }),
            );
        }),
      );
  }),
);
