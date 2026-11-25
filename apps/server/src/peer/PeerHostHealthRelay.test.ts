import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { makeSnapshot } from "../hostHealth/HostHealth.testkit.ts";
import * as HostHealthService from "../hostHealth/HostHealthService.ts";
import * as LinkHostHealthHttp from "./linkHostHealthHttp.ts";
import * as PeerHostHealthRelay from "./PeerHostHealthRelay.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box", { linkHostHealth: true });

/** B, whose own health service answers with a fixed sample and history. */
const serveBox = (descriptor = box) =>
  servePeer(descriptor, Layer.empty, LinkHostHealthHttp.layer).pipe(
    Effect.provide(
      Layer.mock(HostHealthService.HostHealthService)({
        latest: Effect.succeed(makeSnapshot(1_000, { cpu: 42, temp: 61 })),
        readHistory: ({ range }) =>
          Effect.succeed({
            range,
            resolutionSeconds: 120,
            points: [
              {
                timestamp: 1_000,
                cpuPercent: 42,
                load1m: 1,
                memoryUsedBytes: 500,
                memoryTotalBytes: 1000,
                swapUsedBytes: 0,
                diskReadBytesPerSec: null,
                diskWriteBytesPerSec: null,
                netRxBytesPerSec: 10,
                netTxBytesPerSec: 20,
                maxTempCelsius: 61,
              },
            ],
          }),
      }),
    ),
  );

/** A, holding the link and reading B's health for its own clients. */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const relay = yield* PeerHostHealthRelay.layer.pipe(
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(FetchHttpClient.layer),
    Layer.build,
  );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    relay: Context.get(relay, PeerHostHealthRelay.PeerHostHealthRelay),
  };
});

it.effect("reads a linked machine's health and history over the link, at any access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox();
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "read-only");

      const snapshot = yield* a.relay.snapshot({ environmentId: box.environmentId });
      expect(snapshot.cpu.utilizationPercent).toBe(42);
      expect(snapshot.sensors.map((sensor) => sensor.value)).toEqual([61]);

      const history = yield* a.relay.history({ environmentId: box.environmentId, range: "24h" });
      expect(history).toMatchObject({ range: "24h", resolutionSeconds: 120 });
      expect(history.points.map((point) => point.cpuPercent)).toEqual([42]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("says a linked machine is too old instead of asking it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox(descriptorOf("environment-box", "Box"));
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b);

      const failure = yield* a.relay
        .snapshot({ environmentId: box.environmentId })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ reason: "incompatible", label: "Box" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a machine this environment is not linked to", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* makeLaptop;
      const failure = yield* a.relay
        .history({ environmentId: box.environmentId, range: "1h" })
        .pipe(Effect.flip);
      expect(failure.reason).toBe("unknown_link");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
