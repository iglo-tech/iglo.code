// @effect-diagnostics nodeBuiltinImport:off -- Real runtime transport acceptance fixture.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpMiddleware, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as RpcHttpServer from "../rpcHttpServer.ts";
import { guardHttpResponseWriteErrors } from "../httpResponseErrorGuard.ts";

const responses = new WeakMap<NodeHttp.IncomingMessage, NodeHttp.ServerResponse>();
let middlewareSawResponseEnd = false;
const middleware = HttpMiddleware.make((app) =>
  app.pipe(
    Effect.tap(() =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.source instanceof NodeHttp.IncomingMessage) {
          middlewareSawResponseEnd = responses.get(request.source)?.writableEnded ?? false;
        }
      }),
    ),
  ),
);

const app = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.url === "/middleware-observation") {
    return HttpServerResponse.text(String(middlewareSawResponseEnd));
  }
  if (request.url.includes("refuse")) return HttpServerResponse.text("refused", { status: 401 });
  if (request.url.startsWith("/range") || request.url.startsWith("/gzip")) {
    const plain = Buffer.alloc(65536, 97);
    const gzip = request.url.startsWith("/gzip");
    if (gzip) {
      let state = 0x12345678;
      for (let index = 0; index < plain.length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        plain[index] = state >>> 24;
      }
    }
    const bytes = gzip ? NodeZlib.gzipSync(plain) : plain;
    return HttpServerResponse.raw(
      NodeStream.Readable.from([bytes.subarray(0, 32), bytes.subarray(32)]),
      {
        status: gzip ? 200 : 206,
        headers: {
          "content-length": String(bytes.length),
          ...(gzip ? { "content-encoding": "gzip" } : { "content-range": "bytes 0-65535/1048576" }),
        },
      },
    );
  }
  if (!request.url.startsWith("/ws") && !request.url.startsWith("/browser")) {
    return HttpServerResponse.text("HTTP retained");
  }
  const socket = yield* request.upgrade;
  const writer = yield* socket.writer;
  const reader = yield* socket.reader;
  if (request.url.includes("end")) {
    // Finish while the peer is open, including a pending compressed data frame.
    yield* writer.write("hello");
    return HttpServerResponse.empty();
  }
  return yield* Effect.forever(
    reader.pull.pipe(
      Effect.flatMap((messages) =>
        Effect.forEach(messages, (message) => writer.write(message), { discard: true }),
      ),
    ),
  );
});

const serving = Layer.effectDiscard(
  Effect.gen(function* () {
    const http = yield* HttpServer.HttpServer;
    yield* http.serve(app, middleware);
    if (http.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
    const port = http.address.port;
    yield* Effect.sync(() => process.stdout.write(`rpc-fixture:${port}\n`));
  }),
).pipe(
  Layer.provide(
    RpcHttpServer.layer(
      () =>
        guardHttpResponseWriteErrors(
          NodeHttp.createServer().on("request", (request, response) =>
            responses.set(request, response),
          ),
        ),
      {
        host: "127.0.0.1",
        port: 0,
        gracefulShutdownTimeout: 250,
      },
    ),
  ),
);
NodeRuntime.runMain(Layer.launch(serving));
