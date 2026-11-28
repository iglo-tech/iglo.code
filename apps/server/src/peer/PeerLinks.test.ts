// @effect-diagnostics-next-line nodeBuiltinImport:off - The HTTPS test server needs certificate bytes.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - A peer with a certificate this machine does not trust.
import * as NodeHttps from "node:https";
import { NodeHttpServer } from "@effect/platform-node";
import {
  AuthSessionId,
  type ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Tool, Toolkit } from "effect/ai";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  servePeer,
  type ServedPeer,
} from "./PeerLinks.testkit.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

import { layerReaderDatabase, traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";

/** What B's probe saw: the calling client and the modes it may start work with. */
const Probe = Schema.Struct({ caller: Schema.String, modes: Schema.String });

const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Reports the calling client and the modes it may start work with.",
    success: Probe,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("refuse", {
    description: "Always refuses.",
    success: Probe,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);

const probeHandlers = McpToolAccess.toLayer(ProbeToolkit, {
  probe: McpToolAccess.reads(() =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.map((scope) => {
        const modes = McpInvocationContext.clientModeCeiling(scope.client);
        return {
          caller: scope.client?.label ?? "none",
          modes: `${modes.runtimeMode}/${modes.interactionMode}`,
        };
      }),
    ),
  ),
  refuse: McpToolAccess.reads(() =>
    Effect.fail(
      new OrchestratorMcpFailure({ code: "thread_not_found", message: "No such thread." }),
    ),
  ),
});

const serveB = (descriptor: ExecutionEnvironmentDescriptor) =>
  servePeer(descriptor, McpHttpServer.toolkitRegistration(ProbeToolkit, probeHandlers));

/** Environment A, which links to B. */
const makeA = (
  descriptor: ExecutionEnvironmentDescriptor,
  secrets?: typeof ServerSecretStore.layer,
) =>
  layerLinkingEnvironment(descriptor, secrets).pipe(
    Layer.build,
    Effect.map((context) => ({
      links: Context.get(context, PeerLinks.PeerLinks),
      peer: Context.get(context, PeerMcpClient.PeerMcpClient),
      sql: Context.get(context, SqlClient.SqlClient),
      settings: Context.get(context, ServerSettings.ServerSettingsService),
    })),
  );

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const probe = (
  a: Effect.Success<ReturnType<typeof makeA>>,
  limits: PeerMcpClient.PeerCallLimits = { runtimeMode: "full-access", interactionMode: "default" },
  tool = "probe",
) =>
  a.peer.call({
    environmentId: box.environmentId,
    tool,
    arguments: {},
    limits,
    success: Probe,
  });

const linkedSessions = (b: ServedPeer) => b.linkedSessions;

/** Another environment on a socket of its own, answering as `descriptor`. */
const serveApart = (descriptor: ExecutionEnvironmentDescriptor) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) => serveB(descriptor).pipe(Effect.provideContext(server))),
  );

it.effect("routes peer reads to readers and sees uncommitted link updates", () =>
  Effect.gen(function* () {
    const context = yield* layerLinkingEnvironment(
      laptop,
      ServerSecretStore.layer,
      layerReaderDatabase,
    ).pipe(Layer.build);
    const links = Context.get(context, PeerLinks.PeerLinks);
    const sql = Context.get(context, SqlClient.SqlClient);
    yield* sql`
      INSERT INTO peer_environment_links (
        environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced
      ) VALUES (
        ${box.environmentId}, 'test-secret', 'Box', '[]', 'auto',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1
      )
    `;
    const { queries, trace } = traceSqlRouting();
    yield* links.list.pipe(trace);
    expect(Option.getOrThrow(yield* links.get(box.environmentId).pipe(trace)).label).toBe("Box");
    const reads = queries.filter(({ query }) =>
      query.includes("SELECT * FROM peer_environment_links"),
    );
    expect(reads).toHaveLength(2);
    expect(reads.map((row) => row.connection)).toEqual(["reader", "reader"]);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE peer_environment_links SET label = 'Uncommitted box'`;
        expect(Option.getOrThrow(yield* links.get(box.environmentId)).label).toBe(
          "Uncommitted box",
        );
        expect((yield* links.list)[0]?.label).toBe("Uncommitted box");
      }),
    );
    expect(yield* links.unlink(box.environmentId)).toMatchObject({
      removed: true,
      endedThere: false,
    });
    expect(yield* links.list).toEqual([]);
  }),
);

it.effect("links with a pairing code, and the peer holds its agents to the limits they carry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);

      const refused = yield* a.links
        .link({ url: b.url, pairingCode: "not-a-code" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("pairing_rejected");
      expect(yield* linkedSessions(b)).toEqual([]);

      const pairing = yield* b.auth.issuePairingCredential({
        access: "full-access",
        purpose: "peer-link",
      });
      const linked = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
      });
      expect(linked).toMatchObject({
        environmentId: box.environmentId,
        label: "Box",
        urls: [b.url],
        access: "full-access",
      });
      // B lists the link under A's name, where it can be revoked.
      expect((yield* linkedSessions(b)).map((session) => session.client.label)).toEqual([
        "iglo.code · Laptop",
      ]);
      expect(
        (yield* a.links.list).map(({ environmentId, status }) => [environmentId, status]),
      ).toEqual([[box.environmentId, "reachable"]]);

      // The caller's limits narrow the link's access; they never widen it.
      expect(
        yield* probe(a, { runtimeMode: "approval-required", interactionMode: "plan" }),
      ).toEqual({ caller: "iglo.code · Laptop", modes: "approval-required/plan" });
      expect(yield* probe(a)).toEqual({
        caller: "iglo.code · Laptop",
        modes: "full-access/default",
      });

      // A refusal keeps the peer's reason.
      const notFound = yield* probe(a, undefined, "refuse").pipe(Effect.flip);
      expect(notFound).toMatchObject({ code: "thread_not_found", message: "No such thread." });

      // Unlinking ends the session on B too, instead of leaving a live credential behind.
      expect(yield* a.links.unlink(box.environmentId)).toMatchObject({
        removed: true,
        endedThere: true,
      });
      expect(yield* linkedSessions(b)).toEqual([]);

      // An address that now answers as another environment never receives the token.
      const other = yield* serveApart(descriptorOf("environment-other", "Other"));
      const relink = yield* b.auth.issuePairingCredential({
        access: "full-access",
        purpose: "peer-link",
      });
      yield* a.links.link({ url: b.url, pairingCode: relink.credential });
      yield* a.sql`UPDATE peer_environment_links SET urls_json = ${JSON.stringify([other.url])}`;
      expect(yield* a.links.unlink(box.environmentId)).toMatchObject({
        removed: true,
        endedThere: false,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "each machine's Linked environments beta gates links, and a link waits while it is off",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(box);
        const a = yield* makeA(laptop);
        const pairing = yield* b.auth.issuePairingCredential();
        const link = a.links.link({ url: b.url, pairingCode: pairing.credential });

        yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        expect(yield* link.pipe(Effect.flip)).toMatchObject({
          reason: "disabled",
          message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
        });
        expect(yield* Ref.get(b.bearers)).toEqual([]);

        yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: true });
        yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        const refusedThere = yield* link.pipe(Effect.flip);
        expect(refusedThere.reason).toBe("pairing_rejected");
        expect(refusedThere.message).toContain("Linked environments is off on that machine");
        expect(yield* linkedSessions(b)).toEqual([]);

        yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: true });
        yield* link;
        yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        // Not final, so a task already running there picks up again once it is back on.
        const waiting = yield* probe(a).pipe(Effect.flip);
        expect(waiting.code).toBe("orchestration_error");
        expect(waiting.message).toContain("has Linked environments turned off");
        yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: true });
        expect(yield* probe(a)).toEqual({
          caller: "iglo.code · Laptop",
          modes: "full-access/default",
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a link whose row cannot be stored keeps none of its token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const held = yield* Ref.make<ReadonlySet<string>>(new Set());
      const noted = Layer.effect(
        ServerSecretStore.ServerSecretStore,
        Effect.map(ServerSecretStore.make, (store) =>
          ServerSecretStore.ServerSecretStore.of({
            ...store,
            set: (name, value) =>
              store
                .set(name, value)
                .pipe(Effect.andThen(Ref.update(held, (names) => new Set([...names, name])))),
            remove: (name) =>
              store
                .remove(name)
                .pipe(
                  Effect.andThen(
                    Ref.update(held, (names) => new Set([...names].filter((at) => at !== name))),
                  ),
                ),
          }),
        ),
      );
      const a = yield* makeA(laptop, noted);
      yield* a.sql`
        CREATE TRIGGER refuse_link BEFORE INSERT ON peer_environment_links
        BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
      `;
      const pairing = yield* b.auth.issuePairingCredential();
      const failed = yield* a.links
        .link({ url: b.url, pairingCode: pairing.credential })
        .pipe(Effect.flip);
      expect(failed.reason).toBe("storage");
      expect(yield* Ref.get(held)).toEqual(new Set());
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("two links racing to one peer leave the stored access matching the token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const [first, second] = yield* Effect.all(
        [b.auth.issuePairingCredential(), b.auth.issuePairingCredential()],
        { concurrency: 2 },
      );
      yield* Effect.all(
        [
          a.links.link({ url: b.url, pairingCode: first.credential }),
          a.links.link({ url: b.url, pairingCode: second.credential }),
        ],
        { concurrency: 2 },
      );
      const [stored] = yield* a.links.list;
      // The token sent is the one issued with the access the row records.
      expect(stored!.access).toBe("full-access");
      expect((yield* probe(a)).modes).toBe("full-access/default");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** A bare HTTP server on a socket of its own, answering with `handle`. */
const serveRaw = <E, R>(
  handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      Effect.gen(function* () {
        yield* HttpServer.serve(Effect.flatMap(HttpServerRequest.HttpServerRequest, handle)).pipe(
          Layer.build,
        );
        const address = (yield* HttpServer.HttpServer).address;
        if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
        return `http://127.0.0.1:${address.port}`;
      }).pipe(Effect.provideContext(server)),
    ),
  );

it.effect("never follows a peer's redirect with the pairing code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const received = yield* Ref.make<ReadonlyArray<string>>([]);
      const elsewhere = yield* serveRaw((request) =>
        Ref.update(received, (seen) => [...seen, `${request.method} ${request.url}`]).pipe(
          Effect.as(HttpServerResponse.empty({ status: 404 })),
        ),
      );
      // Answers as B, then sends every linking request on to another address.
      const front = yield* serveRaw((request) =>
        request.url.startsWith("/.well-known/t3/environment")
          ? HttpClient.get(`${b.url}${request.url}`).pipe(
              Effect.flatMap((response) => response.text),
              Effect.map((body) =>
                HttpServerResponse.text(body, { contentType: "application/json" }),
              ),
              Effect.provide(FetchHttpClient.layer),
              Effect.orDie,
            )
          : Effect.succeed(
              HttpServerResponse.empty({
                status: 307,
                headers: { location: `${elsewhere}${request.url}` },
              }),
            ),
      );
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: front, pairingCode: pairing.credential }).pipe(Effect.flip);
      expect(yield* Ref.get(received)).toEqual([]);
      expect(yield* a.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("never sends a link's token to an address that stops answering as that peer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential });
      yield* probe(a);
      expect((yield* Ref.get(b.bearers)).length).toBeGreaterThan(0);

      // The address now answers as another environment, as a reused LAN address would.
      yield* Ref.set(b.descriptor, descriptorOf("environment-impostor", "Impostor"));
      yield* Ref.set(b.bearers, []);
      const failed = yield* probe(a).pipe(Effect.flip);
      expect(failed.message).toContain("Box did not answer");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["unreachable"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("lists a peer asleep at every address as unreachable within one probe budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      // Another address of the same machine, asleep too.
      const wake = yield* Deferred.make<void>();
      const elsewhere = yield* serveRaw(() =>
        Deferred.await(wake).pipe(Effect.as(HttpServerResponse.empty({ status: 503 }))),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(wake, undefined));
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        alternateUrls: [elsewhere],
        pairingCode: pairing.credential,
      });

      yield* Ref.set(b.asleep, true);
      const listing = yield* a.links.list.pipe(Effect.forkScoped);
      yield* Queue.take(b.unanswered);
      yield* TestClock.adjust(Duration.seconds(3));
      const listed = yield* Fiber.join(listing);
      expect(listed.map((link) => link.status)).toEqual(["unreachable"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("lists a peer as reachable at another address while its first one sleeps", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const described = yield* HttpClient.get(`${b.url}/.well-known/t3/environment`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.provide(FetchHttpClient.layer),
      );
      // Another address of the same machine that answers.
      const elsewhere = yield* serveRaw(() =>
        Effect.succeed(HttpServerResponse.text(described, { contentType: "application/json" })),
      );
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        alternateUrls: [elsewhere],
        pairingCode: pairing.credential,
      });

      yield* Ref.set(b.asleep, true);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["reachable"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("resolves a link at its answering address without waiting out a sleeping first", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const described = yield* HttpClient.get(`${b.url}/.well-known/t3/environment`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.provide(FetchHttpClient.layer),
      );
      const elsewhere = yield* serveRaw(() =>
        Effect.succeed(HttpServerResponse.text(described, { contentType: "application/json" })),
      );
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        alternateUrls: [elsewhere],
        pairingCode: pairing.credential,
      });

      yield* Ref.set(b.asleep, true);
      // The clock never moves: a resolve that probes the sleeping address first never returns.
      // Advancing it would also expire the answering probe if that one was still in flight.
      const first = yield* a.links.resolve(box.environmentId).pipe(Effect.forkScoped);
      yield* Queue.take(b.unanswered);
      expect((yield* Fiber.join(first)).url).toBe(elsewhere);
      expect((yield* a.links.resolve(box.environmentId)).url).toBe(elsewhere);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("cancelling a descriptor probe aborts its request and leaves later resolves fresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hold = yield* Ref.make(false);
      const requests = yield* Ref.make(0);
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const holdDescriptor = HttpRouter.middleware(
        (httpEffect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.url.startsWith("/.well-known/t3/environment")) {
              yield* Ref.update(requests, (count) => count + 1);
              if (yield* Ref.get(hold)) {
                return yield* Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
                  ),
                  Effect.interruptible,
                );
              }
            }
            return yield* httpEffect;
          }),
        { global: true },
      );
      const b = yield* servePeer(
        box,
        Layer.merge(McpHttpServer.toolkitRegistration(ProbeToolkit, probeHandlers), holdDescriptor),
      );
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential });
      yield* Ref.set(b.bearers, []);
      yield* Ref.set(requests, 0);
      yield* Ref.set(hold, true);

      const resolving = yield* a.links.resolve(box.environmentId).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(resolving);
      yield* Deferred.await(interrupted);

      yield* Ref.set(hold, false);
      expect((yield* a.links.resolve(box.environmentId)).url).toBe(b.url);
      expect(yield* Ref.get(requests)).toBe(2);
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("one dropped descriptor request does not list a live peer as unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dropNext = yield* Ref.make(false);
      const dropOnce = HttpRouter.middleware(
        (httpEffect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (
              request.url.startsWith("/.well-known/t3/environment") &&
              (yield* Ref.getAndSet(dropNext, false))
            ) {
              return HttpServerResponse.empty({ status: 503 });
            }
            return yield* httpEffect;
          }),
        { global: true },
      );
      const b = yield* servePeer(
        box,
        Layer.merge(McpHttpServer.toolkitRegistration(ProbeToolkit, probeHandlers), dropOnce),
      );
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential });

      yield* Ref.set(dropNext, true);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["reachable"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("reads one stored link without asking the peer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential });
      yield* Ref.set(b.probes, 0);

      const stored = yield* a.links.get(box.environmentId);
      expect(Option.map(stored, (link) => link.label)).toEqual(Option.some("Box"));
      expect(Option.isNone(yield* a.links.get(laptop.environmentId))).toBe(true);
      expect(yield* a.links.names).toEqual([{ environmentId: box.environmentId, label: "Box" }]);
      expect(yield* Ref.get(b.probes)).toBe(0);

      // An older answer that lands after a newer one never moves the expiry back.
      const expiresAt = Option.getOrThrow(stored).expiresAt;
      const later = DateTime.add(expiresAt, { days: 20 });
      yield* a.links.recordExpiry(box.environmentId, later);
      yield* a.links.recordExpiry(box.environmentId, DateTime.add(expiresAt, { days: 10 }));
      expect(
        Option.map(yield* a.links.get(box.environmentId), (link) =>
          DateTime.formatIso(link.expiresAt),
        ),
      ).toEqual(Option.some(DateTime.formatIso(later)));
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a linked peer that is renamed shows its new name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential });

      yield* Ref.set(b.descriptor, descriptorOf(box.environmentId, "Box Mini"));
      expect((yield* a.links.resolve(box.environmentId)).link.label).toBe("Box Mini");
      const stored = yield* a.links.get(box.environmentId);
      expect(Option.map(stored, (link) => link.label)).toEqual(Option.some("Box Mini"));

      yield* Ref.set(b.descriptor, descriptorOf(box.environmentId, "Box Studio"));
      expect((yield* a.links.list).map((link) => link.label)).toEqual(["Box Studio"]);
      const storedAfterList = yield* a.links.get(box.environmentId);
      expect(Option.map(storedAfterList, (link) => link.label)).toEqual(Option.some("Box Studio"));
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a link forgotten while it resolves says it is not linked, not that it lost its credential",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(box);
        const beforeGet = yield* Ref.make<Effect.Effect<void>>(Effect.void);
        const racing = Layer.effect(
          ServerSecretStore.ServerSecretStore,
          Effect.map(ServerSecretStore.make, (store) =>
            ServerSecretStore.ServerSecretStore.of({
              ...store,
              get: (name) =>
                Ref.getAndSet(beforeGet, Effect.void).pipe(
                  Effect.flatten,
                  Effect.andThen(store.get(name)),
                ),
            }),
          ),
        );
        const a = yield* makeA(laptop, racing);
        const pairing = yield* b.auth.issuePairingCredential();
        yield* a.links.link({ url: b.url, pairingCode: pairing.credential });

        yield* Ref.set(beforeGet, Effect.orDie(Effect.asVoid(a.links.unlink(box.environmentId))));
        const forgotten = yield* probe(a).pipe(Effect.flip);
        expect(forgotten.message).toContain("not linked to");
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("tells the agent to link again once the peer revokes the link or it expires", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential });
      yield* probe(a);

      const [session] = yield* linkedSessions(b);
      yield* b.auth.revokeSession(session!.sessionId);
      const revoked = yield* probe(a).pipe(Effect.flip);
      expect(revoked.code).toBe("capability_denied");
      expect(revoked.message).toContain("revoked there");

      yield* a.links.link({
        url: b.url,
        pairingCode: (yield* b.auth.issuePairingCredential()).credential,
      });
      // A link made with a peer that later answers without the fence, as
      // one made before the fence or a peer moved back to such a version.
      yield* Ref.set(b.descriptor, descriptorOf("environment-box", "Box", { linkFence: false }));
      yield* Ref.set(b.bearers, []);
      const unfenced = yield* probe(a).pipe(Effect.flip);
      expect(unfenced.code).toBe("capability_denied");
      expect(unfenced.message).toContain("cannot keep a linked agent's limits");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      yield* Ref.set(b.descriptor, box);

      // A link stored before links were marked: its session there is not a
      // link's, so the peer would not fence its work even though it can.
      yield* a.sql`UPDATE peer_environment_links SET fenced = 0`;
      // Linking again is its only way back, as for an expired link.
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["expired"]);
      const legacy = yield* probe(a).pipe(Effect.flip);
      expect(legacy.code).toBe("capability_denied");
      expect(legacy.message).toContain("Link it again");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      yield* a.links.link({
        url: b.url,
        pairingCode: (yield* b.auth.issuePairingCredential()).credential,
      });
      yield* probe(a);

      yield* TestClock.adjust(Duration.days(31));
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["expired"]);
      expect(yield* a.links.names).toEqual([]);
      yield* Ref.set(b.bearers, []);
      const expired = yield* probe(a).pipe(Effect.flip);
      expect(expired.code).toBe("capability_denied");
      expect(expired.message).toContain("expired");
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "refuses to link itself, plain http off this machine and the tailnet, or a peer that cannot hold a linked agent to its limits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(
          descriptorOf("environment-box", "Box", { mcpModeLimitHeader: false }),
        );
        const a = yield* makeA(laptop);
        const pairing = yield* b.auth.issuePairingCredential();
        const older = yield* a.links
          .link({ url: b.url, pairingCode: pairing.credential })
          .pipe(Effect.flip);
        expect(older.reason).toBe("incompatible");
        // Nor one whose link's work could reach the user's own threads there.
        yield* Ref.set(b.descriptor, descriptorOf("environment-box", "Box", { linkFence: false }));
        const unfenced = yield* a.links
          .link({ url: b.url, pairingCode: pairing.credential })
          .pipe(Effect.flip);
        expect(unfenced.reason).toBe("incompatible");

        // Plain http to a LAN address would carry the code and token in clear.
        const lan = yield* a.links
          .link({
            url: "http://192.168.1.20:3773",
            pairingCode: pairing.credential,
          })
          .pipe(Effect.flip);
        expect(lan.message).toContain("plain http");
        const lanAlternate = yield* a.links
          .link({
            url: b.url,
            alternateUrls: ["http://192.168.1.20:3773"],
            pairingCode: pairing.credential,
          })
          .pipe(Effect.flip);
        expect(lanAlternate.message).toContain("plain http");

        yield* Ref.set(b.descriptor, laptop);
        const self = yield* a.links
          .link({ url: b.url, pairingCode: pairing.credential })
          .pipe(Effect.flip);
        expect(self.reason).toBe("self");
        // Neither attempt spent the pairing code on a session.
        expect(yield* linkedSessions(b)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "linking a picked machine skips an address that answers as another, and never signs in there",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const impostor = yield* serveApart(descriptorOf("environment-impostor", "Impostor"));
        const b = yield* serveB(box);
        const a = yield* makeA(laptop);
        const pairing = yield* b.auth.issuePairingCredential();
        const linked = yield* a.links.link({
          url: impostor.url,
          alternateUrls: [b.url],
          pairingCode: pairing.credential,
          expectedEnvironmentId: box.environmentId,
        });
        expect(linked).toMatchObject({ environmentId: box.environmentId, urls: [b.url] });
        // A picked machine is never linked at this machine's own loopback.
        const own = yield* a.links
          .link({
            url: b.url.replace("127.0.0.1", "localhost"),
            pairingCode: pairing.credential,
            expectedEnvironmentId: box.environmentId,
          })
          .pipe(Effect.flip);
        expect(own.message).toContain("is this machine");
        yield* probe(a);
        expect(yield* linkedSessions(impostor)).toEqual([]);
        expect(yield* Ref.get(impostor.bearers)).toEqual([]);
        expect((yield* linkedSessions(b)).length).toBe(1);

        // An address alone that answers as the linked box never takes over its link.
        yield* Ref.set(impostor.descriptor, box);
        const second = yield* impostor.auth.issuePairingCredential();
        const taken = yield* a.links
          .link({ url: impostor.url, pairingCode: second.credential })
          .pipe(Effect.flip);
        expect(taken.message).toContain("already linked");
        expect(yield* linkedSessions(impostor)).toEqual([]);
        expect(Option.getOrUndefined(yield* a.links.get(box.environmentId))?.urls).toEqual([b.url]);
        // The address the link already has still renews it.
        const renewal = yield* b.auth.issuePairingCredential();
        expect(yield* a.links.link({ url: b.url, pairingCode: renewal.credential })).toMatchObject({
          urls: [b.url],
        });
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("linking a picked machine that answers nowhere names it and links nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const impostor = yield* serveApart(descriptorOf("environment-impostor", "Impostor"));
      const a = yield* makeA(laptop);
      const failed = yield* a.links
        .link({
          url: impostor.url,
          alternateUrls: ["http://192.168.1.20:3773"],
          pairingCode: "unused",
          expectedEnvironmentId: box.environmentId,
          expectedLabel: "Box",
        })
        .pipe(Effect.flip);
      expect(failed.reason).toBe("unreachable");
      expect(failed.answeredAs).toBe("Impostor");
      expect(failed.message).toBe(
        `This environment could not reach Box: ${new URL(impostor.url).origin} answered as another environment, Impostor. http://192.168.1.20:3773 is plain http, which would send the link's credentials unencrypted. Use its https address, or its Tailscale name (*.ts.net).`,
      );
      expect(yield* a.links.list).toEqual([]);
      expect(yield* linkedSessions(impostor)).toEqual([]);

      // Every address refused: the message says why.
      const refused = yield* a.links
        .link({
          url: "http://192.168.1.20:3773",
          pairingCode: "unused",
          expectedEnvironmentId: box.environmentId,
          expectedLabel: "Box",
        })
        .pipe(Effect.flip);
      expect(refused.message).toContain("This environment could not reach Box");
      expect(refused.message).toContain("plain http");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("linking an address with nothing listening says so, unlike one that is not iglo.code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Any test worker can reuse a closed ephemeral port; port 2 is privileged and outside that range.
      const closed = "http://127.0.0.1:2";
      const notT3 = yield* serveRaw(() =>
        Effect.succeed(
          HttpServerResponse.text("<h1>Not Found</h1>", { status: 404, contentType: "text/html" }),
        ),
      );
      const a = yield* makeA(laptop);
      const linking = (url: string) =>
        a.links.link({ url, pairingCode: "unused" }).pipe(Effect.flip);
      expect((yield* linking(closed)).message).toBe(`${closed} did not answer (ECONNREFUSED).`);
      expect((yield* linking(notT3)).message).toBe(
        `${notT3} answered, but not as an iglo.code environment this version understands.`,
      );
      expect(yield* a.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** An https listener whose certificate this machine does not trust. */
const serveUntrusted = Layer.build(
  Layer.fresh(
    NodeHttpServer.layerServer(
      () =>
        NodeHttps.createServer({
          key: NodeFS.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url)),
          cert: NodeFS.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url)),
        }),
      { port: 0, host: "127.0.0.1" },
    ),
  ),
).pipe(
  Effect.map((server) => {
    const address = Context.get(server, HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") throw new Error("expected a TCP address");
    return `https://127.0.0.1:${address.port}`;
  }),
);

it.effect("names an untrusted certificate instead of calling the peer something else", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const untrusted = yield* serveUntrusted;
      const a = yield* makeA(laptop);
      const failed = yield* a.links
        .link({ url: untrusted, pairingCode: "unused" })
        .pipe(Effect.flip);
      expect(failed.reason).toBe("unreachable");
      expect(failed.message).toContain("certificate this machine rejected");
      expect(failed.message).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");
      expect(yield* a.links.list).toEqual([]);

      // A stored link tries its next address past an untrusted one.
      const b = yield* serveB(box);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential });
      yield* a.sql`
        UPDATE peer_environment_links
        SET urls_json = ${JSON.stringify([untrusted, b.url])}
        WHERE environment_id = ${box.environmentId}
      `;
      expect((yield* a.links.resolve(box.environmentId)).url).toBe(b.url);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["reachable"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it("reads Node's TLS verification code from anywhere in a cause chain", () => {
  for (const code of [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "HOSTNAME_MISMATCH",
    "INVALID_CA",
    "INVALID_PURPOSE",
    "PATH_LENGTH_EXCEEDED",
  ]) {
    expect(PeerLinks.certificateErrorCode({ code })).toBe(code);
  }
  const wrapped = { message: "fetch failed", cause: { cause: { code: "INVALID_CA" } } };
  expect(PeerLinks.certificateErrorCode(wrapped)).toBe("INVALID_CA");
  expect(PeerLinks.certificateErrorCode({ cause: { code: "ECONNREFUSED" } })).toBeUndefined();
  expect(PeerLinks.certificateErrorCode(new Error("timed out"))).toBeUndefined();
});

// A reciprocal link needs both environments on sockets of their own, each able
// to sign the other in; `serveApart` gives A its own, as the tests with an
// impostor peer do.
const makeServedA = () => serveApart(laptop);

it.effect("a batch link links back and reports it, and leaves a linked machine as it is", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      const first = yield* a.links.linkUnlessLinked({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      expect(first).toMatchObject({ alreadyLinked: false, reciprocal: { kind: "linked" } });
      expect(yield* b.links.list).toMatchObject([{ environmentId: laptop.environmentId }]);
      const again = yield* a.links.linkUnlessLinked({
        url: b.url,
        pairingCode: (yield* b.auth.issuePairingCredential()).credential,
        reciprocal: true,
      });
      expect(again).toMatchObject({ alreadyLinked: true, reciprocal: { kind: "off" } });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("one link serves both directions, and forgetting removes both sides", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      const created = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      expect(created.reciprocal).toEqual({ kind: "linked" });
      expect(created).toMatchObject({ environmentId: box.environmentId });
      // The peer linked back: its own list holds this environment, at the access the link chose.
      expect(yield* b.links.list).toMatchObject([
        { environmentId: laptop.environmentId, label: "Laptop", access: "full-access" },
      ]);
      // Each side's session for the other, as each Sharing & access lists.
      expect((yield* linkedSessions(b)).map((session) => session.client.label)).toEqual([
        "iglo.code · Laptop",
      ]);
      expect((yield* linkedSessions(a)).map((session) => session.client.label)).toEqual([
        "iglo.code · Box",
      ]);
      // Forgetting here ends both halves: the row on each side, and the session each held there.
      const removed = yield* a.links.unlink(box.environmentId);
      expect(removed).toEqual({ removed: true, endedThere: true, remote: { kind: "removed" } });
      expect(yield* a.links.list).toEqual([]);
      expect(yield* b.links.list).toEqual([]);
      expect(yield* linkedSessions(b)).toEqual([]);
      expect(yield* linkedSessions(a)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a link asked to stay one way leaves the peer unlinked back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      const created = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: false,
      });
      expect(created.reciprocal).toEqual({ kind: "off" });
      expect(yield* b.links.list).toEqual([]);
      // The forward half still stands, as one-way links always have.
      expect((yield* linkedSessions(b)).map((session) => session.client.label)).toEqual([
        "iglo.code · Laptop",
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("unlinking a one-way link reports the peer's side as already gone, not kept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: false,
      });
      // B never linked back, so its teardown finds no row there.
      const removed = yield* a.links.unlink(box.environmentId);
      expect(removed).toEqual({ removed: true, endedThere: true, remote: { kind: "removed" } });
      expect(yield* a.links.list).toEqual([]);
      expect(yield* b.links.list).toEqual([]);
      // The session B held for this side still went with the link.
      expect(yield* linkedSessions(b)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a peer from before reciprocal links keeps linking one way", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const older = descriptorOf("environment-older", "Older", { peerLinkReciprocal: false });
      const b = yield* serveB(older);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      const created = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      expect(created.reciprocal).toEqual({ kind: "unsupported" });
      expect(yield* b.links.list).toEqual([]);
      expect(Option.isSome(yield* a.links.get(older.environmentId))).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// The refused port makes the peer's probe wait out its retry, so the clock runs.
it.live("a peer that cannot reach back keeps the forward link and says why", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      // Nothing answers for this environment, as a machine behind no tailnet would.
      yield* Ref.set(a.ownOrigins, ["http://127.0.0.1:1"]);
      const pairing = yield* b.auth.issuePairingCredential();
      const created = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      const reciprocal = created.reciprocal ?? ({ kind: "off" } as const);
      expect(reciprocal).toMatchObject({ kind: "failed" });
      if (reciprocal.kind === "failed") {
        expect(reciprocal.message).toContain("Box could not link back");
      }
      expect(Option.isSome(yield* a.links.get(box.environmentId))).toBe(true);
      expect(yield* b.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a reciprocal offer may only name the environment its session came from", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const refusal = yield* b.links
        .acceptReciprocal(
          {
            sessionId: AuthSessionId.make("session:impostor"),
            peerEnvironmentId: "environment-impostor",
          },
          {
            environmentId: laptop.environmentId,
            label: "Laptop",
            urls: [b.url],
            pairingCode: "READ-CCCCCCCCCCCC",
            access: "auto",
          },
        )
        .pipe(Effect.flip);
      expect(refusal.reason).toBe("pairing_rejected");
      expect(yield* b.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a teardown over a link from before this change ends its session and nothing else", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      // A peer-link session that declared no environment id, as an older iglo.code signs in.
      const session = yield* b.auth.issueMcpClientSession({
        label: "iglo.code · Old laptop",
        access: "auto",
        peerLink: true,
        client: { deviceType: "bot" },
      });
      const removed = yield* b.links.forgetPeer(
        { sessionId: session.sessionId, peerEnvironmentId: undefined },
        laptop.environmentId,
      );
      expect(removed).toEqual({ removed: false, kept: false });
      expect(yield* linkedSessions(b)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the reciprocal endpoints refuse a session that is not a peer link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const session = yield* b.auth.issueMcpClientSession({
        label: "An agent",
        access: "read-only",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      const fetchContext = yield* FetchHttpClient.layer.pipe(Layer.build);
      const client = Context.get(fetchContext, HttpClient.HttpClient);
      const response = yield* client.post(`${b.url}/api/peer-links/teardown`, {
        headers: { authorization: `Bearer ${session.token}` },
        body: HttpBody.jsonUnsafe({ environmentId: laptop.environmentId }),
      });
      expect(response.status).toBe(403);
      expect(yield* b.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a link that does not ask for reciprocity links one way, whatever older callers assumed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(box);
        const a = yield* makeServedA();
        const pairing = yield* b.auth.issuePairingCredential();
        // No `reciprocal` on the wire means no link back: an older client that
        // never chose silently links one way.
        const created = yield* a.links.link({
          url: b.url,
          pairingCode: pairing.credential,
        });
        expect(created.reciprocal).toEqual({ kind: "off" });
        expect(Option.isSome(yield* a.links.get(box.environmentId))).toBe(true);
        expect(yield* b.links.list).toEqual([]);
        expect((yield* linkedSessions(b)).map((session) => session.client.label)).toEqual([
          "iglo.code · Laptop",
        ]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an accepted offer never moves a link this environment already holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      // B now holds a row for A, bound to the session the offer arrived over.
      const [offeringSession] = yield* linkedSessions(b);
      // An impostor that answers as A offers its own address for A.
      const impostor = yield* serveApart(descriptorOf(laptop.environmentId, "Laptop"));
      const impostorPairing = yield* impostor.auth.issuePairingCredential({
        access: "auto",
        purpose: "peer-link",
      });
      const refused = yield* b.links
        .acceptReciprocal(
          {
            sessionId: offeringSession!.sessionId,
            peerEnvironmentId: laptop.environmentId,
          },
          {
            environmentId: laptop.environmentId,
            label: "Laptop",
            urls: [impostor.url],
            pairingCode: impostorPairing.credential,
            access: "auto",
          },
        )
        .pipe(Effect.flip);
      expect(refused.reason).toBe("pairing_rejected");
      expect(refused.message).toContain("already linked");
      // The row B holds still points at A's real address, and resolves there.
      expect(Option.getOrUndefined(yield* b.links.get(laptop.environmentId))?.urls).toEqual([
        a.url,
      ]);
      expect((yield* b.links.resolve(laptop.environmentId)).url).toBe(a.url);
      expect(yield* linkedSessions(impostor)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an accepted offer does not move a link that appeared while it signed in", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // B stores a link row's token through its secret store; wrapping `set`
      // lets the test drop a competing row for this environment in after the
      // accept path read the table but before it writes.
      const gate = yield* Ref.make<Option.Option<SqlClient.SqlClient>>(Option.none());
      const inserted = yield* Ref.make(false);
      const wrote = yield* Ref.make<ReadonlyArray<string>>([]);
      const removed = yield* Ref.make<ReadonlyArray<string>>([]);
      const secrets = Layer.effect(
        ServerSecretStore.ServerSecretStore,
        Effect.map(ServerSecretStore.make, (store) =>
          ServerSecretStore.ServerSecretStore.of({
            ...store,
            set: (name, value) =>
              Effect.gen(function* () {
                const sql = yield* Ref.get(gate);
                if (Option.isSome(sql) && (yield* Ref.getAndSet(inserted, true)) === false) {
                  yield* sql.value`
                    INSERT INTO peer_environment_links (
                      environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced
                    ) VALUES (
                      ${laptop.environmentId}, 'competing-secret', 'Competing', '["http://127.0.0.1:9"]', 'auto',
                      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1
                    )
                  `.pipe(Effect.orDie);
                }
                yield* Ref.update(wrote, (names) => [...names, name]);
                yield* store.set(name, value);
              }),
            remove: (name) =>
              Ref.update(removed, (names) => [...names, name]).pipe(
                Effect.andThen(store.remove(name)),
              ),
          }),
        ),
      );
      const b = yield* servePeer(
        box,
        McpHttpServer.toolkitRegistration(ProbeToolkit, probeHandlers),
        Layer.empty,
        secrets,
      );
      yield* Ref.set(gate, Option.some(b.sql));
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      const created = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      const reciprocal = created.reciprocal ?? ({ kind: "off" } as const);
      expect(reciprocal).toMatchObject({ kind: "failed" });
      if (reciprocal.kind === "failed") {
        expect(reciprocal.message).toContain("Box could not link back");
      }
      // The forward half still stands.
      expect(Option.isSome(yield* a.links.get(box.environmentId))).toBe(true);
      // The row that appeared mid-sign-in is exactly as it was.
      const rows = yield* b.sql`
        SELECT secret_name, label, urls_json FROM peer_environment_links
        WHERE environment_id = ${laptop.environmentId}
      `;
      expect(rows).toEqual([
        {
          secret_name: "competing-secret",
          label: "Competing",
          urls_json: '["http://127.0.0.1:9"]',
        },
      ]);
      // The rejected write's own token was cleaned up; the competing row's was not.
      const [written] = yield* Ref.get(wrote);
      expect(yield* Ref.get(removed)).toContain(written);
      expect(yield* Ref.get(removed)).not.toContain("competing-secret");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a renewal from the accepting side signs in where the link already reaches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      // Another socket answers as B, and B's own addresses now list it first.
      const twin = yield* serveApart(box);
      yield* Ref.set(b.ownOrigins, [twin.url, b.url]);
      // B renews both ways; its offer names the twin before its own address.
      const pairingAgain = yield* a.auth.issuePairingCredential();
      const renewed = yield* b.links.link({
        url: a.url,
        pairingCode: pairingAgain.credential,
        reciprocal: true,
      });
      expect(renewed.reciprocal).toEqual({ kind: "linked" });
      // A's row for B still names only the address it already held.
      expect(Option.getOrThrow(yield* a.links.get(box.environmentId)).urls).toEqual([b.url]);
      expect((yield* a.links.resolve(box.environmentId)).url).toBe(b.url);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a teardown only touches the row its own session is bound to", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      // A second linked peer session on B, claiming to be A.
      const impostorSession = yield* b.auth.issueMcpClientSession({
        label: "iglo.code · Laptop",
        access: "auto",
        peerLink: true,
        peerEnvironmentId: laptop.environmentId,
        client: { deviceType: "bot" },
      });
      const refused = yield* b.links.forgetPeer(
        {
          sessionId: impostorSession.sessionId,
          peerEnvironmentId: laptop.environmentId,
        },
        laptop.environmentId,
      );
      expect(refused).toEqual({ removed: false, kept: true });
      // The row survives, and the impostor's own session is revoked.
      expect(Option.isSome(yield* b.links.get(laptop.environmentId))).toBe(true);
      const remaining = yield* linkedSessions(b);
      expect(remaining.map((session) => session.sessionId)).not.toContain(
        impostorSession.sessionId,
      );
      // The bound session can still forget its own link.
      const [bound] = yield* linkedSessions(b);
      const removed = yield* b.links.forgetPeer(
        { sessionId: bound!.sessionId, peerEnvironmentId: laptop.environmentId },
        laptop.environmentId,
      );
      expect(removed).toEqual({ removed: true, kept: false });
      expect(yield* b.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("forgetting ends the peer's session here even when it cannot be asked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      expect((yield* linkedSessions(a)).length).toBe(1);
      // B stops answering entirely.
      yield* Ref.set(b.asleep, true);
      const forgetting = yield* a.links.unlink(box.environmentId).pipe(Effect.forkScoped);
      yield* Queue.take(b.unanswered);
      // Probe timeout, one retry, probe timeout again.
      yield* TestClock.adjust(Duration.seconds(8));
      const removed = yield* Fiber.join(forgetting);
      expect(removed.removed).toBe(true);
      expect(removed.remote?.kind).toBe("off");
      expect(yield* a.links.list).toEqual([]);
      // The session B held here went with the link, without asking B.
      expect(yield* linkedSessions(a)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "a peer that keeps its side on teardown is reported as kept, with how to end the session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(box);
        const a = yield* makeServedA();
        const pairing = yield* b.auth.issuePairingCredential();
        yield* a.links.link({
          url: b.url,
          pairingCode: pairing.credential,
          reciprocal: true,
        });
        // B's row for A predates session binding: no peer_session_id.
        yield* b.sql`UPDATE peer_environment_links SET peer_session_id = NULL`;
        const removed = yield* a.links.unlink(box.environmentId);
        expect(removed).toEqual({
          removed: true,
          endedThere: true,
          remote: { kind: "kept", message: expect.stringContaining("Sharing & access") },
        });
        expect(yield* a.links.list).toEqual([]);
        // B kept its row; its own side can still forget it.
        expect((yield* b.links.list).length).toBe(1);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "an old peer without the reciprocal endpoint revokes this side's session there by token",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const older = descriptorOf("environment-older", "Older", { peerLinkReciprocal: false });
        const b = yield* serveB(older);
        const a = yield* makeA(laptop);
        const pairing = yield* b.auth.issuePairingCredential();
        yield* a.links.link({
          url: b.url,
          pairingCode: pairing.credential,
          reciprocal: false,
        });
        yield* Ref.set(b.bearers, []);
        const removed = yield* a.links.unlink(older.environmentId);
        expect(removed.removed).toBe(true);
        expect(removed.endedThere).toBe(true);
        expect(removed.remote?.kind).toBe("off");
        if (removed.remote?.kind === "off") {
          expect(removed.remote.message).toContain("runs an iglo.code version");
          expect(removed.remote.message).toContain("Connections");
        }
        // No teardown call was made: the old peer has no such route.
        expect(yield* Ref.get(b.bearers)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.live("a failed reciprocal offer revokes the one-time code it minted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeServedA();
      // Nothing answers for this environment, so the offer fails.
      yield* Ref.set(a.ownOrigins, ["http://127.0.0.1:1"]);
      const pairing = yield* b.auth.issuePairingCredential();
      const created = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        reciprocal: true,
      });
      expect(created.reciprocal).toMatchObject({ kind: "failed" });
      // The grant minted for the failed offer is revoked, not live for its lifetime.
      const active = yield* a.auth.listPairingLinks();
      expect(active.some((link) => link.label === "Link back to Laptop")).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// The refused ports make the probe wait out its retry, so the clock runs.
it.live("a failed offer's answer does not echo per-address probe results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      // The offering session on B names Laptop.
      const session = yield* b.auth.issueMcpClientSession({
        label: "iglo.code · Laptop",
        access: "auto",
        peerLink: true,
        peerEnvironmentId: laptop.environmentId,
        client: { deviceType: "bot" },
      });
      const refused = yield* b.links
        .acceptReciprocal(
          { sessionId: session.sessionId, peerEnvironmentId: laptop.environmentId },
          {
            environmentId: laptop.environmentId,
            label: "Laptop",
            urls: ["http://127.0.0.1:1", "http://127.0.0.1:2"],
            pairingCode: "unused",
            access: "auto",
          },
        )
        .pipe(Effect.flip);
      expect(refused.reason).toBe("unreachable");
      expect(refused.message).toBe("The offered addresses did not answer as that environment.");
      expect(refused.message).not.toContain("ECONNREFUSED");
      expect(yield* b.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

/** A links to B both ways, as `environment link` does. */
const linkBothWays = Effect.gen(function* () {
  const b = yield* serveB(box);
  const a = yield* makeServedA();
  yield* a.links.link({
    url: b.url,
    pairingCode: (yield* b.auth.issuePairingCredential()).credential,
    reciprocal: true,
  });
  return { a, b };
});

const urlsOf = (links: PeerLinks.PeerLinks["Service"], environmentId: typeof box.environmentId) =>
  links.get(environmentId).pipe(Effect.map((link) => Option.getOrThrow(link).urls));

it.effect(
  "a check trades each side's current addresses, keeping only those that answer as it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { a, b } = yield* linkBothWays;
        // Each side now also answers somewhere it did not when linking, as a Serve name
        // whose certificate was still being issued; one address answers as someone else.
        const twinA = yield* serveApart(laptop);
        const twinB = yield* serveApart(box);
        const stranger = yield* serveApart(descriptorOf("environment-stranger", "Stranger"));
        yield* Ref.set(a.ownOrigins, [a.url, twinA.url, stranger.url]);
        yield* Ref.set(b.ownOrigins, [b.url, twinB.url, stranger.url]);

        const checked = yield* a.links.check(box.environmentId);
        expect(checked).toMatchObject({ status: "reachable", lastError: null });
        expect(checked.urls).toEqual([b.url, twinB.url]);
        expect(yield* urlsOf(b.links, laptop.environmentId)).toEqual([a.url, twinA.url]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("linking a linked machine again refreshes the addresses its link back holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { a, b } = yield* linkBothWays;
      expect(yield* urlsOf(b.links, laptop.environmentId)).toEqual([a.url]);
      const twinA = yield* serveApart(laptop);
      yield* Ref.set(a.ownOrigins, [twinA.url, a.url]);

      const again = yield* a.links.linkUnlessLinked({
        url: b.url,
        pairingCode: (yield* b.auth.issuePairingCredential()).credential,
        reciprocal: true,
      });
      expect(again).toMatchObject({ alreadyLinked: true, reciprocal: { kind: "off" } });
      expect(again.link).not.toHaveProperty("status");
      // Added after what the row held, never in its place.
      expect(yield* urlsOf(b.links, laptop.environmentId)).toEqual([a.url, twinA.url]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("only the session a link is bound to may add addresses to it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { a, b } = yield* linkBothWays;
      const twinA = yield* serveApart(laptop);
      const answer = yield* b.links.exchangeOrigins(
        {
          sessionId: AuthSessionId.make("session:someone-else"),
          peerEnvironmentId: "environment-laptop",
        },
        { environmentId: laptop.environmentId, urls: [twinA.url] },
      );
      expect(answer).toEqual({ urls: [b.url] });
      expect(yield* urlsOf(b.links, laptop.environmentId)).toEqual([a.url]);
      // A session may only speak for the environment it signed in as.
      const refused = yield* b.links
        .exchangeOrigins(
          {
            sessionId: AuthSessionId.make("session:someone-else"),
            peerEnvironmentId: "environment-x",
          },
          { environmentId: laptop.environmentId, urls: [twinA.url] },
        )
        .pipe(Effect.flip);
      expect(refused.reason).toBe("pairing_rejected");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a check clears an error a failed call left, and records a revoked link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { a, b } = yield* linkBothWays;
      // One call failed while the peer restarted; nothing has used the link since.
      yield* a.links.recordOutcome(box.environmentId, {
        error: "The linked environment stopped answering.",
      });
      expect((yield* a.links.list)[0]?.lastError).not.toBeNull();
      expect(yield* a.links.check(box.environmentId)).toMatchObject({
        status: "reachable",
        lastError: null,
      });

      const [session] = (yield* linkedSessions(b)).filter(
        (entry) => entry.client.label === "iglo.code · Laptop",
      );
      yield* b.auth.revokeSession(session!.sessionId);
      const revoked = yield* a.links.check(box.environmentId);
      expect(revoked.status).toBe("reachable");
      expect(revoked.lastError).toContain("no longer accepts this link");
      expect(Option.getOrThrow(yield* a.links.get(box.environmentId)).lastError).toBe(
        revoked.lastError,
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a check of a peer that does not answer lists it unreachable and keeps its record", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      yield* a.links.link({
        url: b.url,
        pairingCode: (yield* b.auth.issuePairingCredential()).credential,
      });
      yield* Ref.set(b.asleep, true);
      const checking = yield* a.links.check(box.environmentId).pipe(Effect.forkScoped);
      yield* Queue.take(b.unanswered);
      yield* TestClock.adjust(PeerLinks.probeTimeout(b.url));
      const checked = yield* Fiber.join(checking);
      expect(checked).toMatchObject({ status: "unreachable", lastError: null });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("linking a machine again whose link it revoked links it anew with the code given", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { a, b } = yield* linkBothWays;
      const [session] = (yield* linkedSessions(b)).filter(
        (entry) => entry.client.label === "iglo.code · Laptop",
      );
      yield* b.auth.revokeSession(session!.sessionId);
      const again = yield* a.links.linkUnlessLinked({
        url: b.url,
        pairingCode: (yield* b.auth.issuePairingCredential()).credential,
        reciprocal: true,
      });
      expect(again).toMatchObject({ alreadyLinked: false, link: { lastError: null } });
      expect(yield* a.links.check(box.environmentId)).toMatchObject({
        status: "reachable",
        lastError: null,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
