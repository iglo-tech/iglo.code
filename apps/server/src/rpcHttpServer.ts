// @effect-diagnostics anyUnknownInErrorContext:off -- HttpServer.make intentionally erases the application error type at this transport boundary.
// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns the Node HTTP upgrade boundary.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpServer } from "effect/http";
import { WebSocketServer } from "ws-rpc";

/** Keeps the HTTP platform and other upgrades, using npm ws only for RPC. */
export const layer = (evaluate: () => NodeHttp.Server, options: NodeHttpServer.Options) =>
  Layer.mergeAll(
    Layer.effect(
      HttpServer.HttpServer,
      Effect.gen(function* () {
        const server = evaluate();
        const http = yield* NodeHttpServer.make(() => server, options);
        let forceClose: ReturnType<typeof setTimeout> | undefined;
        // The alias bypasses Bun's hardcoded `ws` shim, which ignores deflate.
        const rpcSockets = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new WebSocketServer({
                noServer: true,
                // Preserve the built-in Bun ws transport's effective message limit.
                maxPayload: 16 * 1024 * 1024,
                // With context takeover, ws compresses every message; a threshold
                // only applies when serverNoContextTakeover is enabled.
                perMessageDeflate: true,
              }),
          ),
          (sockets) =>
            Effect.callback<void>((resume) =>
              sockets.close(() => {
                clearTimeout(forceClose);
                resume(Effect.void);
              }),
            ),
        );
        return HttpServer.make({
          address: http.address,
          serve: Effect.fnUntraced(function* (app, middleware) {
            const scope = yield* Effect.scope;
            const rpcUpgrade = yield* NodeHttpServer.makeUpgradeHandler(
              Effect.succeed(rpcSockets),
              app,
              { scope: Scope.forkUnsafe(scope, "parallel"), middleware },
            );
            const previous = new Set(server.listeners("upgrade"));
            yield* middleware ? http.serve(app, middleware) : http.serve(app);
            const compatibilityUpgrade = server
              .listeners("upgrade")
              .find((listener) => !previous.has(listener)) as typeof rpcUpgrade | undefined;
            if (!compatibilityUpgrade) {
              return yield* Effect.die(
                new Error("Node HTTP server did not register its upgrade handler"),
              );
            }
            const upgrade: typeof rpcUpgrade = (request, socket, head) => {
              if (request.url?.split("?", 1)[0] === "/ws") {
                rpcUpgrade(request, socket, head);
              } else {
                compatibilityUpgrade(request, socket, head);
              }
            };
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                server.off("upgrade", upgrade);
                // Close before request scopes are interrupted: a pending socket
                // pull can hold their cleanup until the close handshake starts.
                for (const socket of rpcSockets.clients) socket.close(1001, "server shutting down");
                if (rpcSockets.clients.size > 0) {
                  // A peer need not acknowledge close. Bound request-scope cleanup
                  // as well as ws server cleanup, within the HTTP shutdown budget.
                  const grace = Math.min(
                    1000,
                    Duration.toMillis(
                      Duration.fromInputUnsafe(options.gracefulShutdownTimeout ?? "20 seconds"),
                    ),
                  );
                  // @effect-diagnostics-next-line globalTimersInEffect:off -- Must fire while request-scope interruption waits for peers to close.
                  forceClose = setTimeout(() => {
                    for (const socket of rpcSockets.clients) socket.terminate();
                  }, grace);
                }
              }),
            );
            server.off("upgrade", compatibilityUpgrade);
            server.on("upgrade", upgrade);
          }),
        });
      }),
    ),
    NodeHttpServer.layerHttpServices,
  );
