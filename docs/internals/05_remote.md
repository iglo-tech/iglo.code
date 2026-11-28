# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. LAN, Tailscale, and SSH
change how the client reaches the server; they do not introduce a different execution model.
Upstream's T3 Connect relay is disabled in this fork ([T3 Connect](./06_t3-connect.md)).

## Identity is independent of the route

- An environment keeps its ID across restarts and endpoint changes. Repository identity can
  correlate clones across environments (preferring `upstream` for PR features, grouping forks by
  `origin`), but work never silently crosses environments.
- [Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts) publishes
  atomically and retains repair state so concurrent initializers choose the same winner; do not
  sweep that recovery state as temp cleanup.
- **Routes are untrusted hints.** Only the connecting client can prove reachability. Never fall back
  to loopback when a shareable endpoint is unavailable (loopback names the client's own machine).
  Verify a direct or learned route answers as the expected environment before sending credentials,
  and never let a token paired over HTTPS downgrade to plain HTTP.
- Pull request routing trust covers the saved route set: adding or changing a route revokes trust;
  reordering does not.

## Peer links

A [peer link](../../apps/server/src/peer/PeerLinks.ts) lets one environment's agents work in another
by signing in to the target's `/mcp` as an ordinary OAuth client (`iglo-code-peer-link`). The receiving
side lists and revokes it in Sharing & access like any other session, and owns its expiry/renewal.

- **One link serves both directions (fork).** Upstream links one direction per sign-in. Here, after
  the forward sign-in, the linking environment mints its own one-time peer-link code and offers it
  over `/api/peer-links/reciprocal` ([PeerLinks](../../apps/server/src/peer/PeerLinks.ts)), and the
  peer links back at full access. Every first-party caller sends `reciprocal: true`, so there is no
  one-way option; unset `reciprocal` on the wire still means one way, so older clients and mixed
  versions interoperate. A client that may talk to an older server also sends `access`, which
  this server ignores and an older one requires. The accepting side passes `reciprocal: false` so offers never loop, and a failed
  offer revokes its code. Offered addresses are only those the peer's `peerOrigin` accepts
  ([OwnLinkOrigins](../../apps/server/src/peer/OwnLinkOrigins.ts)): MagicDNS names, probed to
  answer as this environment whatever process published Serve, so a CLI link and a service that
  never set `IGLO_CODE_TAILSCALE_SERVE` still offer one. A bare 100.64.0.0/10 address is refused
  there, since other VPNs share the range, so it is never offered.
- **Links are re-checked and trade addresses (fork).** A link stores only addresses that answered
  when it was made, and its `last_error` used to clear only on the next call through it. Each
  server now runs `PeerLinks.check` on every link on a timer
  ([PeerLinkKeepAlive](../../apps/server/src/peer/PeerLinkKeepAlive.ts)), on **Check now**, on
  `iglo.code environment check`, and when `linkUnlessLinked` meets a held link. The check calls
  `/api/peer-links/origins` with the link's token: a refusal is recorded, an answer clears the
  record, and silence only lists the peer unreachable. The call carries the caller's own addresses
  and the answer the callee's; each side adds only those that answer as the other, never moving or
  dropping one it holds. Pushed addresses join only a row bound to the calling session, and nothing
  about them is echoed back. A Serve name's first HTTPS request issues its certificate, which can
  take tens of seconds, so [OwnLinkOrigins](../../apps/server/src/peer/OwnLinkOrigins.ts) gives
  that self-probe its own long budget, apart from `tailscale status`.
- **Forget is two teardowns.** `PeerLinks.unlink` removes the link and revokes the peer's session
  here, then asks the peer over `/api/peer-links/teardown` to do the same; each hop fires only when
  a row was removed, so the hops stop. Each row's `peer_session_id` names the one session that may
  forget it, so an impostor session pays with its own revocation and cannot touch an existing row.
- **The declared id is only a claim.** The peer's environment id rides the OAuth registration as
  `software_version` and is signed into the session (`peid`), but the accept path never moves an
  existing link row whatever address an offer carries. A both-ways link still grants whichever
  environment you gave a pairing code to a session under the id it claims, at full access.

- **Every link made here is full access (fork).** `PeerLinks.link`, `linkUnlessLinked`, link-pairing
  codes and the reciprocal offer ignore any caller's access and use full access, so the choice has
  no surface. Only an accepted reciprocal offer and rows already stored keep the lower access an
  older version sent, so mixed versions still link and nothing is migrated. A managed `maxRuntimeMode`
  below full access does not refuse a link: it caps what the link's agents may start, as for any
  outside agent, and that machine will not mint a link-pairing code ([`PeerClientPairing`](../../apps/server/src/peer/PeerClientPairing.ts)).
- **Devices follow links (fork).** The web client joins every machine its connected machines link
  to through the client pairing a full-access link mints
  ([LinkedEnvironmentsAutoConnect](../../apps/web/src/components/LinkedEnvironmentsAutoConnect.tsx)),
  so that pairing must stay available on every link. The device keeps, per browser, which machines
  it joined that way, which the user removed while linked, and each machine's last link list; it
  drops a joined machine once no machine it holds on its own reaches it, chains included. The
  catalog is not synced across tabs, so one tab (a held Web Lock) acts for the device.
- **Mode ceilings always narrow.** Forwarded calls carry the calling agent's modes in
  `T3-Mode-Limit`, which the receiving `/mcp` can only intersect downward with the link's approved
  access.
- **Non-full-access links are fenced by `linkOrigin`.** Only links from an older version are below full access. Threads launched by a peer link (and their
  derived forks, subagents, and spawned threads) carry an immutable `linkOrigin` stamp enforced in
  shared access rules ([`mcp/linkOrigin.ts`](../../apps/server/src/mcp/linkOrigin.ts)). Below full
  access, linked work can mutate only threads with the same origin, cannot touch projects, settings,
  scheduled tasks, or further links, and skips project setup scripts and worktree layout commands
  (in a project that declares a layout, a worktree launch or handoff for such a thread fails;
  restoring a missing folder brings back plain checkouts). Full-access links are not fenced because
  their agents already run as the receiving OS user. Being unfenced only answers who asked: a
  layout command still runs only with a person's approval of its text, and for an agent only from
  a thread in Full access, both checked in
  [`TaskFolders`](../../apps/server/src/workspace/TaskFolders.ts) at every run.
- **Namespace idempotency keys.** All callers on the linking side share one session on the receiving
  side, so idempotency keys must be hashed with the caller's namespace before forwarding.
- **Clients read linked threads as standard thread streams.**
  [`PeerThreadRelay`](../../apps/server/src/peer/PeerThreadRelay.ts) proxies the same stream format
  read-only so there is no second transcript schema to maintain.

## The web client is a client

Each server serves the web client, and the browser stores its connection catalog locally and
connects directly to each environment, including ones other than the server that served the page. No
server proxies another's traffic or holds the catalog, so a page loaded over HTTPS (such as through
Tailscale Serve) cannot reach a plain HTTP LAN backend. Pairing URLs carry the secret in the
fragment, which never reaches a server in a request; the browser exchanges it and strips it from
history. Moving the token into a query parameter would disclose it to whatever origin serves the page.

## Access and process ownership are separate

- Tailscale supplies an endpoint for normal pairing; auth remains the environment's responsibility.
- SSH reaches a server through a port the user forwards to a server they started there. The browser has
  no SSH launcher: upstream's desktop app owned that lifecycle, and the
  [launcher](../../packages/ssh/src/tunnel.ts) has no caller here. The server uses only
  [SSH commands](../../packages/ssh/src/command.ts) for remote device hosts.
- Remote servers outlive client releases. Clients negotiate features via advertised capabilities
  rather than assuming version parity. Process replacement uses the
  [update protocol](./07_server-updates.md).
