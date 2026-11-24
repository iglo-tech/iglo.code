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
  peer links back at the same access. It is on by default; the **Link back** checkbox (`--one-way`
  on the CLI) opts out, and unset `reciprocal` on the wire means one way, so mixed versions
  interoperate. The accepting side passes `reciprocal: false` so offers never loop, and a failed
  offer revokes its code. Offered addresses are tailnet entries only
  ([OwnLinkOrigins](../../apps/server/src/peer/OwnLinkOrigins.ts)): the peer's own address rules refuse
  plain-http LAN and loopback.
- **Forget is two teardowns.** `PeerLinks.unlink` removes the link and revokes the peer's session
  here, then asks the peer over `/api/peer-links/teardown` to do the same; each hop fires only when
  a row was removed, so the hops stop. Each row's `peer_session_id` names the one session that may
  forget it, so an impostor session pays with its own revocation and cannot touch an existing row.
- **The declared id is only a claim.** The peer's environment id rides the OAuth registration as
  `software_version` and is signed into the session (`peid`), but the accept path never moves an
  existing link row whatever address an offer carries. A both-ways link still grants whichever
  environment you gave a pairing code to a session under the id it claims; choose access accordingly.

- **Mode ceilings always narrow.** Forwarded calls carry the calling agent's modes in
  `T3-Mode-Limit`, which the receiving `/mcp` can only intersect downward with the link's approved
  access.
- **Non-full-access links are fenced by `linkOrigin`.** Threads launched by a peer link (and their
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
