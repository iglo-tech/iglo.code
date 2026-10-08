// @effect-diagnostics nodeBuiltinImport:off -- Verifies pairing through actual Bun SQLite bindings.
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as EnvironmentAuth from "../EnvironmentAuth.ts";
import * as SessionStore from "../SessionStore.ts";

const services = EnvironmentAuth.layerRuntime.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), process.argv[2]!)),
  Layer.provide(NodeServices.layer),
);
const metadata = {
  deviceType: "desktop" as const,
  os: "fixture",
  browser: "fixture",
  ipAddress: "127.0.0.1",
};

const issued = await Effect.runPromise(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const pairing = yield* auth.issuePairingCredential({ scopes: ["orchestration:read"] });
    const exchange = yield* auth.createBrowserSession(pairing.credential, metadata);
    const session = yield* sessions.verify(exchange.sessionToken);
    NodeAssert.deepEqual(session.scopes, ["orchestration:read"]);
    const oauthPairing = yield* auth.issuePairingCredential({ scopes: ["orchestration:read"] });
    const denied = yield* auth
      .exchangeBootstrapCredentialForAccessToken(
        oauthPairing.credential,
        ["access:write"],
        metadata,
      )
      .pipe(Effect.flip);
    NodeAssert.equal(denied._tag, "ServerAuthScopeNotGrantedError");
    const oauth = yield* auth.exchangeBootstrapCredentialForAccessToken(
      oauthPairing.credential,
      ["orchestration:read"],
      metadata,
    );
    NodeAssert.equal(oauth.scope, "orchestration:read");
    return { browserToken: exchange.sessionToken, oauthToken: oauth.access_token, pairing };
  }).pipe(Effect.provide(services), Effect.scoped),
);

await Effect.runPromise(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    for (const token of [issued.browserToken, issued.oauthToken]) {
      const session = yield* sessions.verify(token);
      NodeAssert.deepEqual(session.scopes, ["orchestration:read"]);
    }
    const consumed = yield* auth
      .createBrowserSession(issued.pairing.credential, metadata)
      .pipe(Effect.flip);
    NodeAssert.equal(consumed._tag, "ServerAuthInvalidCredentialError");
  }).pipe(Effect.provide(services), Effect.scoped),
);
process.stdout.write("paired and persisted browser and scoped OAuth sessions\n");
