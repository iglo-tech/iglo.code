import { AuthMcpClientAccess, EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OwnLinkOrigins from "../peer/OwnLinkOrigins.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Links live in this environment's database and secret store, so these
 * commands work whether or not its server is running.
 */
const runWithPeerLinks = Effect.fn("environment.runWithPeerLinks")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (links: PeerLinks.PeerLinks["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* PeerLinks.PeerLinks.pipe(
    Effect.flatMap(run),
    Effect.provide(
      PeerLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            SqlitePersistence.layerCliConfig,
            FetchHttpClient.layer,
          ),
        ),
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        Layer.provide(
          ServerSettings.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerSecretStore.layer,
                SqlitePersistence.layerCliConfig,
                ManagedPolicy.layer,
              ),
            ),
          ),
        ),
        // Mints the one-time code a peer links back with: the same database
        // and secret store as the rest of this chain, by layer memoization.
        Layer.provide(
          EnvironmentAuth.layer.pipe(
            Layer.provide(ManagedPolicy.layer),
            Layer.provideMerge(
              Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerCliConfig),
            ),
            Layer.provideMerge(ServerEnvironment.layerIdentity),
          ),
        ),
        // Answers a link back with this machine's own addresses.
        Layer.provide(
          OwnLinkOrigins.layer.pipe(
            Layer.provide(
              DirectEndpoints.layer.pipe(
                Layer.provide(FetchHttpClient.layer),
                Layer.provideMerge(
                  ServerEnvironment.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerCliConfig),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeLinks = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.toEncoded(Schema.Unknown))),
);

const formatLinks = (links: ReadonlyArray<PeerLinkSummary>) =>
  links.length === 0
    ? "No linked environments.\n"
    : `${links
        .map(
          (link) =>
            `${link.label} (${link.environmentId})\n  ${link.status}, access ${link.access}, expires ${DateTime.formatIso(link.expiresAt)}\n  ${link.urls.join(", ")}${link.lastError === null ? "" : `\n  last error: ${link.lastError}`}`,
        )
        .join("\n\n")}\n`;

const environmentLinkCommand = Command.make("link", {
  ...authLocationFlags,
  url: Argument.String("url").pipe(
    Argument.withDescription(
      "Where the other environment answers: its T3 Connect, Tailscale, LAN or loopback address.",
    ),
  ),
  alternateUrl: Flag.String("url").pipe(
    Flag.withDescription("Another address for the same environment, tried after the first."),
    Flag.atLeast(0),
  ),
  pairingCode: Flag.String("pairing-code").pipe(
    Flag.withDescription("A pairing code from the other environment (`iglo.code pair` there)."),
  ),
  access: Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "What this environment's agents may do there: read-only, or the broadest runtime mode. The other environment's agents get the same here.",
    ),
    Flag.withDefault("approval-required" as const),
  ),
  oneWay: Flag.Boolean("one-way").pipe(
    Flag.withDescription(
      "Link only this direction, and leave the other environment unlinked here.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Link another T3 Code environment, so agents here can work there and its agents can work here. It shows up there under Authorized clients in Settings → Sharing & access, where it can be revoked.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(flags, (links) =>
      Effect.gen(function* () {
        const created = yield* links.link({
          url: flags.url,
          alternateUrls: flags.alternateUrl,
          pairingCode: flags.pairingCode,
          access: flags.access,
          reciprocal: !flags.oneWay,
        });
        // An older server's plain link carries no outcome: it linked one way.
        const reciprocal =
          created.reciprocal ??
          (flags.oneWay ? ({ kind: "off" } as const) : ({ kind: "unsupported" } as const));
        yield* Console.log(
          `Linked ${created.label} (${created.environmentId}) with ${created.access} access, until ${DateTime.formatIso(created.expiresAt)}.`,
        );
        switch (reciprocal.kind) {
          case "linked":
            yield* Console.log(
              `${created.label} linked back here, so its agents can work in this environment.`,
            );
            break;
          case "off":
            break;
          case "unsupported":
            yield* Console.log(
              `${created.label} runs a T3 Code version that does not link back. Update it there, then link again for both ways.`,
            );
            break;
          case "failed":
            // The outcome's message already names the peer.
            yield* Console.log(reciprocal.message);
            break;
        }
        yield* Console.log("");
      }),
    ),
  ),
);

const environmentListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List linked environments and whether each answers now."),
  Command.withHandler((flags) =>
    runWithPeerLinks(
      flags,
      (links) =>
        Effect.gen(function* () {
          const listed = yield* links.list;
          yield* Console.log(flags.json ? `${yield* encodeLinks(listed)}\n` : formatLinks(listed));
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const environmentUnlinkCommand = Command.make("unlink", {
  ...authLocationFlags,
  environmentId: Argument.String("environment-id").pipe(
    Argument.withDescription("The linked environment's id, from `iglo.code environment list`."),
  ),
}).pipe(
  Command.withDescription(
    "Forget a linked environment here, and there too when it can: its link back goes, and so does this side's session.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(flags, (links) =>
      Effect.gen(function* () {
        const { removed, remote } = yield* links.unlink(EnvironmentId.make(flags.environmentId));
        if (!removed) {
          yield* Console.log(`No linked environment ${flags.environmentId}.\n`);
          return;
        }
        yield* Console.log(`Forgot ${flags.environmentId}.`);
        if (remote === undefined) {
          yield* Console.log("This side held no session token, so the peer was not asked.");
        } else if (remote.kind === "removed") {
          yield* Console.log("Its link back here is gone too, and its session here has ended.");
        } else {
          yield* Console.log(remote.message);
        }
        yield* Console.log("");
      }),
    ),
  ),
);

export const environmentCommand = Command.make("environment").pipe(
  Command.withDescription("Link other T3 Code environments, so agents here can work there."),
  Command.withSubcommands([
    environmentLinkCommand,
    environmentListCommand,
    environmentUnlinkCommand,
  ]),
);
