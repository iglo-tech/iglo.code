import type { ServerDirectEndpoint } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DirectEndpoints from "../environment/DirectEndpoints.ts";

/**
 * Where this environment answers for a peer linking back. Only tailnet
 * entries qualify: the peer's own address rules refuse plain-http LAN and
 * loopback, so offering those only buries the honest "no address" outcome.
 */
export class OwnLinkOrigins extends Context.Service<
  OwnLinkOrigins,
  {
    /** The origins a peer may link back over: this machine's tailnet entries. */
    readonly origins: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/peer/OwnLinkOrigins") {}

const originOf = (endpoint: ServerDirectEndpoint) =>
  URL.parse(endpoint.httpBaseUrl)?.origin ?? endpoint.httpBaseUrl;

/** The tailnet origins, which are the ones a peer can link back over. */
export function ownOriginsFor(input: {
  readonly endpoints: ReadonlyArray<ServerDirectEndpoint>;
}): ReadonlyArray<string> {
  return [
    ...new Set(input.endpoints.filter((endpoint) => endpoint.kind === "tailnet").map(originOf)),
  ];
}

export const layer = Layer.effect(
  OwnLinkOrigins,
  Effect.gen(function* () {
    const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
    return OwnLinkOrigins.of({
      // resolve(), not resolveAvailable(): it is what probes and advertises the
      // Tailscale Serve address, which a CLI run would otherwise never offer.
      origins: Effect.map(directEndpoints.resolve(), (endpoints) => ownOriginsFor({ endpoints })),
    });
  }),
);
