// @effect-diagnostics nodeBuiltinImport:off -- A transient Bun HTTP fixture verifies the public Browser stream wire protocol.
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
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
    const origin = new URL(HttpServer.formatAddress(server.address));
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let close: { code: number; reason: string } | undefined;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = NodeNet.connect(Number(origin.port), origin.hostname);
        socket.on("error", (error) => closed.reject(error));
        socket.on("connect", () =>
          socket.write(
            [
              "GET /api/preview-stream/ws?threadId=thread&tabId=tab HTTP/1.1",
              `Host: ${origin.host}`,
              "Connection: Upgrade",
              "Upgrade: websocket",
              "Sec-WebSocket-Version: 13",
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
              "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits",
              `Origin: ${origin.origin}`,
              "",
              "",
            ].join("\r\n"),
          ),
        );
        socket.on("data", (chunk) => {
          try {
            buffer = Buffer.concat([buffer, chunk]);
            if (!upgraded) {
              const end = buffer.indexOf("\r\n\r\n");
              if (end === -1) return;
              NodeAssert.match(buffer.subarray(0, end).toString(), /^HTTP\/1\.1 101 /u);
              buffer = buffer.subarray(end + 4);
              upgraded = true;
            }
            if (buffer.byteLength < 2) return;
            NodeAssert.equal(buffer[0], 0x88, "The server must send a valid WebSocket close frame");
            const length = buffer[1]!;
            NodeAssert.ok(length >= 2 && length <= 125, "Close payload must be short and unmasked");
            if (buffer.byteLength < length + 2) return;
            NodeAssert.equal(close, undefined, "The server must send only one close frame");
            const payload = buffer.subarray(2, length + 2);
            close = { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString() };
            buffer = buffer.subarray(length + 2);
            NodeAssert.equal(
              buffer.byteLength,
              0,
              "The server must not send HTTP bytes after upgrading",
            );
            // Echo a masked close acknowledgement, then wait for the server's TCP close.
            socket.write(Buffer.concat([Buffer.from([0x88, 0x80 | length, 0, 0, 0, 0]), payload]));
          } catch (error) {
            closed.reject(error);
            socket.destroy();
          }
        });
        socket.on("close", () => {
          if (close && buffer.byteLength === 0) closed.resolve(close);
          else closed.reject(new Error("The server did not complete a valid WebSocket close"));
        });
        return socket;
      }),
      (socket) => Effect.sync(() => socket.destroy()),
    );
    const result = yield* Effect.promise(() => closed.promise);
    NodeAssert.strict.equal(result.code, PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE);
    NodeAssert.strict.equal(result.reason, '{"need":"sandbox","command":"sudo t3 browser setup"}');
    process.stdout.write("Browser stream sends a valid host-setup WebSocket close under Bun.\n");
  }).pipe(Effect.scoped),
);
