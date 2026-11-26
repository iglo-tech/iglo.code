import type {
  AntigravitySettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

// A reading is reused this long, because every health check asks for one.
const READ_EVERY_MS = 5 * 60_000;
const WINDOWS = {
  "Five Hour": { suffix: "5h", label: "5-hour", kind: "session", minutes: 5 * 60 },
  Weekly: { suffix: "weekly", label: "Weekly", kind: "weekly", minutes: 7 * 24 * 60 },
} as const;
const ROW = /^([^\t]+)\t(Weekly|Five Hour) Limit Remaining\t(\d+(?:\.\d+)?)%\t(\S+)$/;

const CliToken = Schema.Struct({ id_token_email: Schema.optional(Schema.String) });
const decodeCliToken = Schema.decodeEffect(Schema.fromJsonString(CliToken));

function quotaGroup(name: string) {
  const family = name.replace(/\s+models$/i, "").trim();
  if (/^claude and gpt$/i.test(family)) return { id: "3p", label: "Claude & GPT (shared)" };
  return { id: family.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: family };
}

/** Windows from the rows `agy -p /usage` prints, read at `now`. */
export function parseAntigravityUsage(output: string, now: number): ServerProviderUsageWindow[] {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const line of output.split(/\r?\n/)) {
    const row = ROW.exec(line.trim());
    if (!row) continue;
    const [, name = "", windowName = "Weekly", remaining = "", reset = ""] = row;
    const group = quotaGroup(name);
    const window = WINDOWS[windowName as keyof typeof WINDOWS];
    const remainingPercent = Math.max(0, Math.min(100, Number(remaining)));
    const parsed = DateTime.make(reset);
    const resetsAt = Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : Number.NaN;
    // Unused windows report the epoch, and an untouched one a rolling full-window reset.
    const untouched =
      remainingPercent === 100 &&
      (resetsAt <= 0 || Math.abs(resetsAt - now - window.minutes * 60_000) <= 5 * 60_000);
    const id = `${group.id}-${window.suffix}`;
    windows.set(id, {
      id,
      label: `${group.label} · ${window.label}`,
      kind: window.kind,
      usedPercent: 100 - remainingPercent,
      windowDurationMins: window.minutes,
      ...(untouched || Option.isNone(parsed) ? {} : { resetsAt: DateTime.formatIso(parsed.value) }),
    });
  }
  return [...windows.values()];
}

/**
 * Reads limits from the CLI's own `/usage` command. Antigravity supports only the CLI and ACP
 * for external clients; Google warned that calling its internal quota APIs can flag an account.
 */
export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  /** Runs `agy -p /usage` against this instance's profile and returns its stdout. */
  readonly readUsage: Effect.Effect<string, { readonly _tag: string }>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Digest.Digest;
  const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "antigravity-oauth-token");
  let last: { at: number; limits: ServerProviderUsageLimits } | undefined;
  let generation = 0;

  const accountFingerprint = Effect.gen(function* () {
    if (!(yield* fs.exists(tokenPath))) return undefined;
    const email = (yield* decodeCliToken(yield* fs.readFileString(tokenPath))).id_token_email
      ?.trim()
      .toLowerCase();
    if (!email) return undefined;
    const digest = yield* crypto.digest(
      Digest.sha256,
      new TextEncoder().encode(`google-email\0${email}`),
    );
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }).pipe(Effect.orElseSucceed(() => undefined));

  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const now = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    if (last && now - last.at < READ_EVERY_MS) return last.limits;
    // Without a saved sign-in the CLI would wait for a browser sign-in instead of answering.
    if (input.authMethod === "oauth-personal" && !(yield* fs.exists(tokenPath))) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in with Google to see Antigravity limits.",
      });
    }
    const windows = parseAntigravityUsage(yield* input.readUsage, now);
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not return usable quota information.",
      });
    }
    const fingerprint = yield* accountFingerprint;
    const limits: ServerProviderUsageLimits = {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
    };
    if (generation === startedGeneration) last = { at: now, limits };
    return limits;
  });

  const probe = read.pipe(
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits. Refresh provider status to retry.",
        });
      }),
    ),
  );
  return {
    probe,
    clear: Effect.sync(() => {
      last = undefined;
      generation++;
    }),
  };
});
