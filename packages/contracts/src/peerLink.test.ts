import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  MAX_RECIPROCAL_OFFER_URLS,
  PeerLink,
  PeerLinkCreateResult,
  PeerLinkReciprocalOffer,
  PeerLinkRequestAnswerResult,
} from "./peerLink.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeAsPeerLink = Schema.decodeUnknownSync(PeerLink);
const decodeAsCreateResult = Schema.decodeUnknownSync(PeerLinkCreateResult);
const isReciprocalOffer = Schema.is(PeerLinkReciprocalOffer);

const link: PeerLink = {
  environmentId: EnvironmentId.make("environment-box"),
  label: "Box",
  urls: ["https://box.tailnet.ts.net"],
  access: "auto",
  linkedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
};

describe("PeerLinkCreateResult stays decodable across versions", () => {
  it("an older client decodes a new server's flat result as a plain link", () => {
    const fromTheWire: unknown = { ...link, reciprocal: { kind: "linked" } };
    expect(decodeAsPeerLink(fromTheWire)).toEqual(link);
  });

  it("a newer client decodes an older server's plain link, with no reciprocal outcome", () => {
    const fromTheWire: unknown = link;
    const decoded = decodeAsCreateResult(fromTheWire);
    expect(decoded).toEqual(link);
    expect("reciprocal" in decoded).toBe(false);
  });
});

describe("PeerLinkReciprocalOffer is bounded", () => {
  const offer = (urls: ReadonlyArray<string>, label = "Laptop") => ({
    environmentId: "environment-laptop",
    label,
    urls,
    pairingCode: "CODE",
    access: "auto",
  });

  it("accepts up to the url cap", () => {
    const urls = Array.from(
      { length: MAX_RECIPROCAL_OFFER_URLS },
      (_, i) => `https://h${i}.example`,
    );
    expect(isReciprocalOffer(offer(urls))).toBe(true);
  });

  it("rejects more urls than the cap, so an offer cannot scan many addresses", () => {
    const urls = Array.from(
      { length: MAX_RECIPROCAL_OFFER_URLS + 1 },
      (_, i) => `https://h${i}.example`,
    );
    expect(isReciprocalOffer(offer(urls))).toBe(false);
  });

  it("rejects an over-long label", () => {
    expect(isReciprocalOffer(offer(["https://h.example"], "x".repeat(201)))).toBe(false);
  });
});

describe("the link-request answer RPC stays decodable across versions", () => {
  const answerRpc = WsRpcGroup.requests.get(WS_METHODS.peerLinksAnswerRequest);

  it("encodes an answer without a result as null, which an older void client decodes", () => {
    expect(answerRpc).toBeDefined();
    const newClientCodec = Schema.toCodecJson(answerRpc!.successSchema);
    // The pre-change success schema was void; its wire value is null.
    const oldClientCodec = Schema.toCodecJson(Schema.Void);
    const wire = Schema.encodeSync(newClientCodec)(undefined);
    expect(wire).toBeNull();
    const oldWire: unknown = wire;
    expect(Schema.decodeUnknownSync(oldClientCodec)(oldWire)).toBeUndefined();
    // And the new client reads the old server's null right back.
    expect(Schema.decodeSync(newClientCodec)(null)).toBeUndefined();
  });

  it("round-trips a link answer with its reciprocal outcome on new clients", () => {
    const value: PeerLinkRequestAnswerResult = {
      result: { ...link, reciprocal: { kind: "linked" } },
    };
    const codec = Schema.toCodecJson(answerRpc!.successSchema);
    const wire = Schema.encodeSync(codec)(value);
    expect(Schema.decodeSync(codec)(wire)).toEqual(value);
  });
});
