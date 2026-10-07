// @effect-diagnostics nodeBuiltinImport:off -- The acceptance dependency is an actual Bun subprocess.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as AcpSessionRuntime from "../../src/provider/acp/AcpSessionRuntime.ts";

const fixture = NodeURL.fileURLToPath(new URL("fake-acp.mjs", import.meta.url));
const makeRuntime = (control: string) =>
  AcpSessionRuntime.make({
    spawn: {
      command: process.env.BUN_EXECUTABLE ?? "bun",
      args: [fixture, "--control", control],
      cwd: control,
    },
    cwd: control,
    clientInfo: { name: "web-auth-regression", version: "1" },
    clientCapabilities: { elicitation: { url: {} } },
    authenticateOnAuthRequired: false,
  });

it.effect("the local ACP dependency requires sign-in and relays a cancellable browser URL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const control = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fake-acp-" });
    const runtime = yield* makeRuntime(control);
    const initialized = yield* runtime.initialize();
    expect(initialized.authMethods).toMatchObject([{ id: "browser", type: "agent" }]);
    const readiness = yield* runtime.start().pipe(Effect.result);
    expect(readiness._tag).toBe("Failure");
    if (readiness._tag === "Failure")
      expect(readiness.failure).toMatchObject({
        code: -32000,
        errorMessage: "Authentication required",
      });
    const url = yield* Deferred.make<string>();
    yield* runtime.handleElicitation((request) => {
      expect(request.mode).toBe("url");
      if (!("url" in request)) return Effect.die("Expected browser URL elicitation");
      return Deferred.succeed(url, request.url).pipe(Effect.andThen(Effect.never));
    });
    const signIn = yield* runtime.authenticate("browser").pipe(Effect.forkScoped);
    expect(yield* Deferred.await(url)).toBe(
      "https://auth.fixture.invalid/authorize?fixture=web-regression",
    );
    yield* Fiber.interrupt(signIn);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("the local ACP dependency reports a controlled sign-in failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const control = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fake-acp-error-" });
    yield* fs.writeFileString(path.join(control, "auth-error"), "fail");
    const runtime = yield* makeRuntime(control);
    const signIn = yield* runtime.authenticate("browser").pipe(Effect.result);
    expect(signIn._tag).toBe("Failure");
    if (signIn._tag === "Failure")
      expect(signIn.failure).toMatchObject({ errorMessage: "Controlled sign-in failure" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
