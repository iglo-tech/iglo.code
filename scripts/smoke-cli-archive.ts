#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";
import * as NodeURL from "node:url";
import { checkEnvironment, createEnvironmentFixture } from "./lib/environment-smoke.ts";

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive").pipe(Flag.optional),
    expectVersion: Flag.String("expect-version").pipe(Flag.withDefault("0.0.0")),
    source: Flag.Boolean("source").pipe(Flag.withDefault(false)),
  },
  (input) =>
    Effect.tryPromise(async () => {
      const fixture = await createEnvironmentFixture(
        input.source
          ? {
              kind: "source",
              repoRoot: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
              bun: process.execPath,
            }
          : {
              kind: "archive",
              archive: Option.getOrThrow(input.archive),
              expectVersion: input.expectVersion,
            },
      );
      try {
        await checkEnvironment(fixture);
        console.log(
          `[environment-smoke] ${input.source ? "source" : "archive"}: authenticated HTTP, cookies, CORS, WebSocket upgrade and persistence across restart passed.`,
        );
      } finally {
        await fixture.dispose();
      }
    }),
).pipe(
  Command.withDescription("Exercise an isolated Bun source environment or extracted CLI archive."),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
