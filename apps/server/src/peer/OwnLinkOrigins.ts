import type { ServerDirectEndpoint } from "@t3tools/contracts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DirectEndpoints from "../environment/DirectEndpoints.ts";

/**
 * Where this environment answers for a peer linking back: only the tailnet
 * addresses the peer's own address rules accept, so offering the rest only
 * buries the honest "no address" outcome.
 */
export class OwnLinkOrigins extends Context.Service<
  OwnLinkOrigins,
  {
    /** The origins a peer may link back over: this machine's tailnet entries. */
    readonly origins: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/peer/OwnLinkOrigins") {}

/**
 * Mirrors `peerOrigin` in PeerLinks: plain http only to a MagicDNS name or
 * Tailscale's IPv6 range. A 100.64.0.0/10 address alone is refused there,
 * since other VPNs share that range.
 */
const peerAccepts = (url: URL) => url.protocol === "https:" || isTailnetHost(url.hostname);

/**
 * Plain http belongs in a link only while no https address is known: once a Serve name
 * answers, the bound port beside it is dropped. Loopback is a test or dev peer and stays.
 */
export const preferHttps = (origins: ReadonlyArray<string>): ReadonlyArray<string> => {
  const parsed = origins.map((origin) => ({ origin, url: URL.parse(origin) }));
  if (!parsed.some(({ url }) => url?.protocol === "https:")) return origins;
  return parsed.flatMap(({ origin, url }) =>
    url !== null && (url.protocol === "https:" || isLocalLoopbackHost(url.hostname))
      ? [origin]
      : [],
  );
};

/** The tailnet origins a peer accepts, which are the ones it can link back over. */
export function ownOriginsFor(input: {
  readonly endpoints: ReadonlyArray<ServerDirectEndpoint>;
}): ReadonlyArray<string> {
  return preferHttps([
    ...new Set(
      input.endpoints.flatMap((endpoint) => {
        const url = URL.parse(endpoint.httpBaseUrl);
        return endpoint.kind === "tailnet" && url !== null && peerAccepts(url) ? [url.origin] : [];
      }),
    ),
  ]);
}

const ORIGINS_TTL = Duration.seconds(30);

export const layer = Layer.effect(
  OwnLinkOrigins,
  Effect.gen(function* () {
    const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
    // A round of checks asks once per link, and each call runs `tailscale status` and probes.
    const origins = yield* Effect.cachedWithTTL(
      Effect.zipWith(
        directEndpoints.resolveTailnetNames({
          probeTimeout: DirectEndpoints.TAILNET_NAME_PROBE_TIMEOUT,
        }),
        directEndpoints.resolveAvailable(),
        (names, bound) => ownOriginsFor({ endpoints: [...names, ...bound] }),
        { concurrent: true },
      ),
      ORIGINS_TTL,
    );
    return OwnLinkOrigins.of({
      // The MagicDNS names come first, so the peer's first try is an https one. A peer
      // keeps only addresses that answer, so a Serve name still getting its certificate
      // is waited for rather than left out.
      origins,
    });
  }),
);
