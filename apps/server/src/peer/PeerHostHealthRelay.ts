import {
  HostHealthHistory,
  HostHealthSnapshot,
  PEER_LINK_HOST_HEALTH_HISTORY_ROUTE,
  PEER_LINK_HOST_HEALTH_SNAPSHOT_ROUTE,
  type PeerLinkError,
  type PeerLinkHostHealthHistoryInput,
  type PeerLinkHostHealthInput,
  PeerLinkHostHealthReadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerLinks from "./PeerLinks.ts";

/**
 * Reads a linked environment's host health for a client of this environment, over the link this
 * environment already holds. Read only, and nothing is kept here between reads.
 */
export class PeerHostHealthRelay extends Context.Service<
  PeerHostHealthRelay,
  {
    readonly snapshot: (
      input: PeerLinkHostHealthInput,
    ) => Effect.Effect<HostHealthSnapshot, PeerLinkHostHealthReadError>;
    readonly history: (
      input: PeerLinkHostHealthHistoryInput,
    ) => Effect.Effect<HostHealthHistory, PeerLinkHostHealthReadError>;
  }
>()("t3/peer/PeerHostHealthRelay") {}

const decodeSnapshot = Schema.decodeUnknownEffect(HostHealthSnapshot);
const decodeHistory = Schema.decodeUnknownEffect(HostHealthHistory);
const decodeRefusal = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

const unreachable = (label: string, cause?: unknown) =>
  new PeerLinkHostHealthReadError({
    reason: "unreachable",
    label,
    message: `${label} did not answer.`,
    ...(cause === undefined ? {} : { cause }),
  });

const incompatible = (label: string) =>
  new PeerLinkHostHealthReadError({
    reason: "incompatible",
    label,
    message: `${label} runs a version that does not share host health over a link. Update it to see its health here.`,
  });

const fromLinkError = (error: PeerLinkError, label: string) =>
  new PeerLinkHostHealthReadError({
    reason:
      error.reason === "unknown_link" ||
      error.reason === "expired" ||
      error.reason === "incompatible"
        ? error.reason
        : "unreachable",
    label,
    message: error.message,
    cause: error,
  });

const fromStatus = (status: number, code: string | undefined, label: string) => {
  if (status === 404) return incompatible(label);
  if (status === 401 || status === 403) {
    return new PeerLinkHostHealthReadError({
      reason: "rejected",
      label,
      message:
        code === "linked_environments_off"
          ? `${label} has Linked environments turned off. Turn it on in its Settings → Labs.`
          : `${label} refused the read. Its link may have been revoked there; link it again.`,
    });
  }
  return unreachable(label, `HTTP ${status}`);
};

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;

  const read = Effect.fn("PeerHostHealthRelay.read")(function* <A>(
    input: PeerLinkHostHealthInput,
    route: string,
    params: Record<string, string>,
    decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) {
    if (!(yield* links.enabled)) {
      return yield* new PeerLinkHostHealthReadError({
        reason: "disabled",
        label: null,
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const link = yield* links.get(input.environmentId).pipe(
      Effect.mapError(
        (error) =>
          new PeerLinkHostHealthReadError({
            reason: "unreachable",
            label: null,
            message: "This environment could not read its links.",
            cause: error,
          }),
      ),
    );
    if (Option.isNone(link)) {
      return yield* new PeerLinkHostHealthReadError({
        reason: "unknown_link",
        label: null,
        message: "This environment is no longer linked to that one.",
      });
    }
    const { label } = link.value;
    const resolved = yield* links
      .resolve(input.environmentId)
      .pipe(Effect.mapError((error) => fromLinkError(error, label)));
    if (resolved.capabilities.linkHostHealth !== true) return yield* incompatible(label);
    const timeout = PeerLinks.probeTimeout(resolved.url);
    const query = new URLSearchParams(params);
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(`${resolved.url}${route}?${query}`).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${resolved.token}` }),
        ),
      )
      .pipe(
        Effect.timeout(timeout),
        Effect.mapError((error) => unreachable(label, error)),
        Effect.tapError((error) =>
          links.recordOutcome(input.environmentId, { error: error.message }),
        ),
      );
    if (response.status !== 200) {
      const refused = yield* response.json.pipe(
        Effect.timeout(timeout),
        Effect.map(decodeRefusal),
        Effect.orElseSucceed(() => Option.none()),
      );
      const failure = fromStatus(response.status, Option.getOrUndefined(refused)?.error, label);
      yield* links.recordOutcome(input.environmentId, { error: failure.message });
      return yield* failure;
    }
    yield* links.recordOutcome(input.environmentId, { error: null });
    // A peer renews a link each time it is used, and says when it now ends.
    const renewed = Option.flatMap(
      Option.fromNullishOr(response.headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]),
      DateTime.make,
    );
    if (Option.isSome(renewed)) yield* links.recordExpiry(input.environmentId, renewed.value);
    return yield* response.json.pipe(
      Effect.timeout(timeout),
      Effect.flatMap(decode),
      Effect.mapError((error) => unreachable(label, error)),
    );
  });

  return PeerHostHealthRelay.of({
    snapshot: Effect.fn("PeerHostHealthRelay.snapshot")(function* (input) {
      return yield* read(input, PEER_LINK_HOST_HEALTH_SNAPSHOT_ROUTE, {}, decodeSnapshot);
    }),
    history: Effect.fn("PeerHostHealthRelay.history")(function* (input) {
      const params = { range: input.range };
      return yield* read(input, PEER_LINK_HOST_HEALTH_HISTORY_ROUTE, params, decodeHistory);
    }),
  });
});

export const layer = Layer.effect(PeerHostHealthRelay, make);
