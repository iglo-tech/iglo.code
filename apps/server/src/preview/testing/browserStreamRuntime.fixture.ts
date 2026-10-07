// @effect-diagnostics nodeBuiltinImport:off -- A transient Bun HTTP fixture verifies the public Browser stream wire protocol.
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as PreviewBrowserHost from "../PreviewBrowserHost.ts";
import * as ServerBrowser from "../ServerBrowser.ts";
import { routeLayer } from "../ServerBrowserStream.ts";

await Effect.runPromise(
  Effect.gen(function* () {
    const browser = ServerBrowser.ServerBrowser.of({
      clearProfile: () => Effect.void,
      openDownload: () => Effect.succeedNone,
      answerFileChooser: () => Effect.succeed(false),
      // A captured child exit reproduces Chromium startup's process I/O boundary.
      attachViewer: () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              NodeChildProcess.execFile(
                process.env.BUN_EXECUTABLE ?? process.execPath,
                ["-e", "process.stdout.write('ready')"],
                (error) => (error ? reject(error) : resolve()),
              );
            }),
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new ServerBrowser.ServerBrowserLaunchError({
                cause: new PreviewBrowserHost.PreviewBrowserSandboxError({
                  setupCommand: "sudo t3 browser setup",
                }),
              }),
            ),
          ),
        ),
    });
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
      authenticateWebSocketUpgrade: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("browser-wire-fixture"),
          subject: "browser-wire-fixture",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationReadScope],
        }),
    });
    const platform = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));
    const services = yield* Layer.build(
      HttpRouter.serve(
        routeLayer.pipe(
          Layer.provide(Layer.succeed(ServerBrowser.ServerBrowser, browser)),
          Layer.provide(HttpRouter.middleware(HttpMiddleware.compression(), { global: true })),
          Layer.provide(platform),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), {
            host: "127.0.0.1",
            port: 0,
            websocket: { perMessageDeflate: true },
          }),
        ),
        Layer.provide(auth),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/u, "ws");
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(`${origin}/api/preview-stream/ws?threadId=thread&tabId=tab`);
        socket.addEventListener("error", (event) =>
          closed.reject(
            new Error(
              `Browser stream WebSocket failed: ${"message" in event ? String(event.message) : "unknown"}`,
            ),
          ),
        );
        socket.addEventListener("close", (event) =>
          closed.resolve({ code: event.code, reason: event.reason }),
        );
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    const result = yield* Effect.promise(() => closed.promise);
    NodeAssert.strict.equal(result.code, PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE);
    NodeAssert.strict.equal(result.reason, '{"need":"sandbox","command":"sudo t3 browser setup"}');
    process.stdout.write("Browser stream sends a valid host-setup WebSocket close under Bun.\n");
  }).pipe(Effect.scoped),
);
