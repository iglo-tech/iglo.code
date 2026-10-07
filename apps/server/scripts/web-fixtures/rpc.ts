import { AuthWebSocketTicketResult, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import type { EnvironmentFixture } from "../../../../scripts/lib/environment-smoke.ts";

const makeClient = RpcClient.make(WsRpcGroup);
const decodeTicket = Schema.decodeUnknownSync(AuthWebSocketTicketResult);
export type RegressionRpcClient = Effect.Success<typeof makeClient>;

/** The same authenticated transport the web client uses, with a scoped socket. */
export async function withRegressionRpc<A>(
  fixture: EnvironmentFixture,
  use: (client: RegressionRpcClient) => Promise<A>,
) {
  const ticket = decodeTicket(
    await (await fixture.request("/api/auth/websocket-ticket", { method: "POST" })).json(),
  );
  const url = new URL("/ws", fixture.origin);
  url.protocol = "ws:";
  url.searchParams.set("wsTicket", ticket.ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  const socket = Socket.layerWebSocket(url.href).pipe(
    Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url) => new WebSocket(url))),
  );
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient;
        return yield* Effect.promise(() => use(client));
      }),
    ).pipe(Effect.provide(protocol)),
  );
}

export const requestRpc = <A, E>(request: Effect.Effect<A, E>) =>
  Effect.runPromise(request.pipe(Effect.timeout("30 seconds")));
