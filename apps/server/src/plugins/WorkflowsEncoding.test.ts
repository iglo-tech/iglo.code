import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { digest } from "../../../../packages/plugin-workflows/src/encoding.ts";

it.effect("preserves persisted workflow identities and payload digests", () =>
  Effect.gen(function* () {
    expect(yield* digest(["environment", "project", "request"])).toBe(
      "0e9c7c579f15f52f01596b96a7453f6724a66bfab9230993c9dbcfc76abc664f",
    );
    const expected = "b2906f87aaa0f57a1831f7aa05b083a68d1644a14d63a757bc612386746423ae";
    expect(yield* digest({ b: [true, null, 2], ignored: undefined, a: "żółć" })).toBe(expected);
    expect(yield* digest({ a: "żółć", b: [true, null, 2] })).toBe(expected);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
