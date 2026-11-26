import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { makeAntigravityUsageProbe, parseAntigravityUsage } from "./antigravityUsageLimits.ts";

const NOW = Date.parse("2026-11-26T16:37:28Z");
// Captured from `agy -p /usage` 1.5.16 on a personal Google account.
const USAGE = [
  "Gemini Models\tWeekly Limit Remaining\t93%\t2026-12-03T08:00:09Z",
  "Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-26T21:37:28Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z",
  "",
].join("\n");

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const fixture = Effect.fn("AntigravityUsageTest.fixture")(function* (
  options: {
    authMethod?: "oauth-personal" | "oauth-business" | "gemini-api-key";
    email?: string;
    missingToken?: boolean;
    output?: string;
    fail?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(profileDirectory, "antigravity-acp"));
  const tokenPath = path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token");
  if (!options.missingToken) {
    yield* fs.writeFileString(
      tokenPath,
      JSON.stringify({
        token: { access_token: "access", refresh_token: "refresh", expiry: "2026-11-26T10:00:00Z" },
        auth_method: "oauth-personal",
        id_token_email: options.email ?? "Someone@Example.com",
      }),
    );
  }
  let reads = 0;
  const usage = yield* makeAntigravityUsageProbe({
    profileDirectory,
    authMethod: options.authMethod ?? "oauth-personal",
    readUsage: Effect.suspend(() => {
      reads++;
      return options.fail
        ? Effect.fail({ _tag: "UsageReadFailed" as const })
        : Effect.succeed(options.output ?? USAGE);
    }),
  });
  return { ...usage, reads: () => reads };
});

describe("parseAntigravityUsage", () => {
  it("reads each quota group's five-hour and weekly windows", () => {
    expect(parseAntigravityUsage(USAGE, NOW)).toEqual([
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        usedPercent: 7,
        windowDurationMins: 10_080,
        resetsAt: "2026-12-03T08:00:09.000Z",
      },
      // Untouched windows report a rolling or epoch reset, which is not a real reset time.
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10_080,
      },
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
    ]);
  });

  it("keeps resets of used windows and names other Gemini quotas apart", () => {
    const windows = parseAntigravityUsage(
      [
        "Signed in as someone",
        "Gemini Argon Models\tFive Hour Limit Remaining\t0%\t2026-11-26T18:00:00Z",
        "Claude and GPT models\tFive Hour Limit Remaining\t41.5%\t2026-11-26T21:37:28Z",
      ].join("\r\n"),
      NOW,
    );
    expect(
      windows.map(({ id, label, usedPercent, resetsAt }) => ({ id, label, usedPercent, resetsAt })),
    ).toEqual([
      {
        id: "gemini-argon-5h",
        label: "Gemini Argon · 5-hour",
        usedPercent: 100,
        resetsAt: "2026-11-26T18:00:00.000Z",
      },
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        usedPercent: 58.5,
        resetsAt: "2026-11-26T21:37:28.000Z",
      },
    ]);
  });
});

describe("Antigravity subscription limits", () => {
  it.effect("reads limits through the CLI and keys them by the signed-in Google account", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const first = yield* fixture();
      const limits = yield* first.probe;
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows.map((window) => window.id).toSorted()).toEqual([
        "3p-5h",
        "3p-weekly",
        "gemini-5h",
        "gemini-weekly",
      ]);
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // The same account on another machine pools with this one.
      const other = yield* fixture({ email: " someone@example.COM " });
      expect((yield* other.probe).credentialFingerprint).toBe(limits.credentialFingerprint);
      const different = yield* fixture({ email: "else@example.com" });
      expect((yield* different.probe).credentialFingerprint).not.toBe(limits.credentialFingerprint);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("reuses a reading for five minutes, and drops it on sign-out", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const usage = yield* fixture();
      yield* usage.probe;
      yield* TestClock.adjust("4 minutes");
      yield* usage.probe;
      expect(usage.reads()).toBe(1);
      yield* TestClock.adjust("1 minute");
      yield* usage.probe;
      expect(usage.reads()).toBe(2);
      yield* usage.clear;
      yield* usage.probe;
      expect(usage.reads()).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("does not run the CLI for API keys or a missing Google sign-in", () =>
    Effect.gen(function* () {
      for (const options of [{ authMethod: "gemini-api-key" as const }, { missingToken: true }]) {
        const usage = yield* fixture(options);
        expect((yield* usage.probe).unavailable?.reason).toBe("unsupported");
        expect(usage.reads()).toBe(0);
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.effect("reports a failed or empty read as a failed probe and retries it next time", () =>
    Effect.gen(function* () {
      for (const options of [{ fail: true }, { output: "Authentication required.\n" }]) {
        const usage = yield* fixture(options);
        expect((yield* usage.probe).unavailable?.reason).toBe("probeFailed");
        yield* usage.probe;
        expect(usage.reads()).toBe(2);
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
