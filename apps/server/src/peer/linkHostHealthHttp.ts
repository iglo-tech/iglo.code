import {
  HostHealthRange,
  PEER_LINK_HOST_HEALTH_HISTORY_ROUTE,
  PEER_LINK_HOST_HEALTH_SNAPSHOT_ROUTE,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerResponse } from "effect/http";

import * as HostHealthService from "../hostHealth/HostHealthService.ts";
import { admitLinkSession, NO_STORE, refusal, withLinkExpiry } from "./linkThreadHttp.ts";

const decodeRange = Schema.decodeUnknownOption(HostHealthRange);

const snapshotRoute = HttpRouter.add(
  "GET",
  PEER_LINK_HOST_HEALTH_SNAPSHOT_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLinkSession;
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const hostHealth = yield* HostHealthService.HostHealthService;
    const snapshot = yield* hostHealth.latest;
    return withLinkExpiry(
      HttpServerResponse.jsonUnsafe(snapshot, { headers: NO_STORE }),
      admitted.linkExpiresAt,
    );
  }),
);

const historyRoute = HttpRouter.add(
  "GET",
  PEER_LINK_HOST_HEALTH_HISTORY_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLinkSession;
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const range = decodeRange(admitted.params.get("range"));
    if (range._tag === "None") return refusal(400, "invalid_request");
    const hostHealth = yield* HostHealthService.HostHealthService;
    const history = yield* hostHealth.readHistory({ range: range.value });
    return withLinkExpiry(
      HttpServerResponse.jsonUnsafe(history, { headers: NO_STORE }),
      admitted.linkExpiresAt,
    );
  }),
);

/** What an environment serves of its host health to the environments linked to it. */
export const layer = Layer.mergeAll(snapshotRoute, historyRoute);
