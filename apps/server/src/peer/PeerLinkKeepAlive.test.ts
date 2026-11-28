import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { CHECK_INTERVAL, checkLinksOnce, nextCheckDelay } from "./PeerLinkKeepAlive.ts";
import * as PeerLinks from "./PeerLinks.ts";

const summary = (id: string, patch: Partial<PeerLinkSummary>): PeerLinkSummary => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  urls: [`https://${id}.example.ts.net`],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(Date.UTC(2100, 0, 1)),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
  ...patch,
});

it("checks a link in trouble again soon, backing off to the regular interval", () => {
  expect(nextCheckDelay(0)).toEqual(CHECK_INTERVAL);
  expect(Duration.toSeconds(nextCheckDelay(1))).toBe(30);
  expect(Duration.toSeconds(nextCheckDelay(2))).toBe(60);
  expect(Duration.toSeconds(nextCheckDelay(3))).toBe(120);
  expect(nextCheckDelay(20)).toEqual(CHECK_INTERVAL);
});

it.effect("checks every unexpired link and says whether all of them work", () =>
  Effect.gen(function* () {
    const results = new Map([
      ["environment-ok", summary("environment-ok", {})],
      ["environment-revoked", summary("environment-revoked", { lastError: "revoked" })],
    ]);
    const checked = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = (ids: ReadonlyArray<string>) =>
      Layer.mock(PeerLinks.PeerLinks)({
        enabled: Effect.succeed(true),
        names: Effect.succeed(
          ids.map((id) => ({ environmentId: EnvironmentId.make(id), label: id })),
        ),
        check: (environmentId) =>
          Ref.update(checked, (seen) => [...seen, environmentId]).pipe(
            Effect.as(results.get(environmentId)!),
          ),
      });
    expect(yield* checkLinksOnce.pipe(Effect.provide(layer(["environment-ok"])))).toBe(true);
    expect(
      yield* checkLinksOnce.pipe(Effect.provide(layer(["environment-ok", "environment-revoked"]))),
    ).toBe(false);
    expect(yield* Ref.get(checked)).toEqual([
      "environment-ok",
      "environment-ok",
      "environment-revoked",
    ]);
  }),
);
