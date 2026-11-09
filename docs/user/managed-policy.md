# Managed policy

A managed policy lets an administrator configure iglo.code for every user on a machine. It sets
defaults and locks for settings, and limits such as the broadest permission mode or which
providers may run. The iglo.code server on the machine enforces it for every browser that connects.

## Roll out a policy

1. Write the policy as JSON, starting from the [example](#write-a-policy).
2. Run `iglo.code policy check policy.json`. It prints what the policy will do, or what is wrong with it.
3. Deploy the policy to each machine with your device management tool, in
   [one of the supported places](#where-the-policy-goes).
4. Restart iglo.code on the machine. The server reads the policy only when it starts.
5. Run `iglo.code policy show` on the machine to
   [check what the server loaded](#check-what-the-server-loaded).

## Write a policy

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "supportUrl": "https://it.example.com/iglo-code",
  "settings": {
    "defaultRuntimeMode": { "value": "approval-required", "locked": false },
    "enableAgentBrowserAccess": { "value": false, "locked": true }
  },
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "clients": ["local-browser"],
    "telemetry": false
  }
}
```

`schemaVersion` and `organization` are required. Users see the organization's name in Settings
and beside each control the policy locks, with a link to `supportUrl` if you set one. [`settings`](#settings)
sets defaults and locks, and [`limits`](#limits) restricts what iglo.code may do.

Every user on the machine can read the policy, so do not put credentials in it.

## Where the policy goes

Use one of these per machine:

| OS    | Native policy                         | Policy file                                          |
| ----- | ------------------------------------- | ---------------------------------------------------- |
| macOS | Configuration profile for `code.iglo` | `/Library/Application Support/iglo.code/policy.json` |
| Linux |                                       | `/etc/iglo.code/policy.json`                         |

iglo.code does not merge sources. If a machine has both a native policy and a policy file, iglo.code
refuses to start until you remove one.

**Policy file.** Copy the JSON to the path for the OS. Make it and its folder writable only by
administrators.

**macOS configuration profile.** Add a custom settings payload for the preference domain
`code.iglo`. The payload's keys are the policy's top-level keys (`schemaVersion`,
`organization`, `supportUrl`, `settings`, `limits`); JSON objects become dictionaries and lists
become arrays. To make the payload from a policy file you checked, run
`plutil -convert xml1 -o code.iglo.plist policy.json` and upload the result, or run
`iglo.code policy templates <directory> --policy policy.json` to write a complete
`macos/iglocode.mobileconfig`. Install it as
a device profile, since iglo.code ignores user profiles, and deploy only one profile for this domain.
A profile cannot hold `null`, so use a policy file if a setting's value must be `null`.

## Check what the server loaded

Run `iglo.code policy show` as the user who runs iglo.code. It prints the installed policy and its
fingerprint, then says whether the running server loaded that policy or an older one. The server
reads the policy only when it starts, so "Restart iglo.code to apply the installed policy" means it
still enforces the old one. In Settings, users see that your organization manages the environment,
and each locked control shows **Managed by**.

## Change or remove a policy

After you deploy, change, or remove a policy, restart the iglo.code server on the machine: run `iglo.code service restart` for the
[background service](./background-service.md), or restart `iglo.code` where you started it. Reconnecting a phone or browser does not reload the
policy.

To remove a policy, delete the file or remove the profile, then restart the server. Users get back the settings they had chosen, since iglo.code never writes policy values
into them.

## When iglo.code refuses to start

iglo.code refuses to start rather than run with a policy it cannot fully enforce. That includes a
policy it cannot read or parse, a setting it does not know, a value of the wrong type, a key this
version does not support, or a machine with both a native policy and a file. The error names where
the policy came from and what is wrong.

`iglo.code policy check` catches the same problems in a JSON file. For a profile, check the JSON
before you convert it. A policy written for a newer version can use keys an older one
cannot enforce, so upgrade iglo.code before you deploy a policy that uses them.

## Settings

Each key under `settings` is a setting's path in the server's `settings.json`, such as
`storageCleanup.logsAfterDays`. To find a path, change the setting in iglo.code and look in
`settings.json` under `~/.iglo.code/userdata`.

- `"locked": false` sets a default. It applies wherever the user has not chosen a value of their
  own, and users can change it.
- `"locked": true` sets the value. Users and agents cannot change it, in Settings or in a project's
  settings, and Settings shows the control as managed by your organization. Removing the policy
  brings back the user's own value.

A few settings need care:

- A default cannot add an entry, such as a provider instance, because users could never remove it.
  Lock the entry instead, or set provider fields with [`providers.instances`](#providers).
- A setting that can be empty, such as `defaultModelSelection`, is managed as a whole. You cannot
  manage one field inside it.
- `defaultRuntimeMode` cannot be broader than [`maxRuntimeMode`](#permission-modes).
- `worktreeCleanup`, which projects can also set, overrides the `worktree` rules in
  `storageCleanup`. Lock it along with those rules; iglo.code refuses a policy that locks only the
  rules.
- `observability` cannot be managed. Its OTLP endpoints come from each user's environment
  variables and settings file, which a policy cannot override.
- Manage `idleCompaction`, not the older `compactIdleThreads`. A Claude instance's own idle
  compaction choice still wins over `idleCompaction`.
- A provider instance's fields override each other, so lock `providerInstances.<id>` as a whole,
  or pin single fields with [`providers.instances`](#providers). iglo.code refuses a lock on one
  field inside an instance. A whole-instance lock covers only that instance; to cover every
  instance of a provider, use `providers.instances`.

## Limits

`limits` restricts what iglo.code may do. Leave a key out to keep iglo.code's normal behavior.

```json
{
  "schemaVersion": 1,
  "organization": "Example Corp",
  "limits": {
    "maxRuntimeMode": "auto-accept-edits",
    "clients": ["local-browser"],
    "webhookTasks": false,
    "browserCookieImport": false,
    "telemetry": false,
    "providers": {
      "allowedDrivers": ["claudeAgent", "codex"],
      "instances": {
        "claudeAgent": {
          "locked": true,
          "environment": [{ "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" }]
        }
      }
    },
    "updates": { "mode": "auto", "allowNightly": false }
  }
}
```

### Permission modes

`maxRuntimeMode` is the broadest [permission mode](./permission-modes.md) any thread may use:
`approval-required` (Supervised), `auto-accept-edits`, `auto`, or `full-access`. It covers threads
that users start, agents start, and scheduled tasks start. A thread already above the limit cannot
run another turn until someone lowers its mode; its queued messages send once that happens. New
threads start at the limit when the user's default is above it.

With `maxRuntimeMode` set, you own each provider's launch settings: binary path, launch arguments,
config home, and the environment variables set on each provider. They come from
[`providers.instances`](#providers) or iglo.code's defaults, and users cannot change them, because a
wrapper script, a launch flag, or a variable such as `NODE_OPTIONS` could otherwise turn off the
provider's approvals. Pin the variables your users need, such as a gateway URL, in
`providers.instances`.

Variables in the environment that starts iglo.code itself still reach providers, and a default
binary path such as `claude` is looked up on that environment's `PATH`. That environment comes from
settings the user controls, such as their shell profile, so a user could put their
own `claude` earlier on their `PATH`. Pin an absolute `binaryPath` in `providers.instances` for each
provider you allow.

ACP agents' own mode menus have no effect under `maxRuntimeMode`, except Antigravity's, whose modes
iglo.code can place under the limit. Users still choose which ACP Registry agent runs; leave
`acpRegistry` out of `allowedDrivers` to stop that.

The limit decides which modes iglo.code asks the provider for. It is not a sandbox; see
[What a policy does not cover](#what-a-policy-does-not-cover).

### Clients

`clients` lists how the server may run:

- `local-browser`: as a server only browsers on this machine reach.
- `remote`: reachable from phones and other computers over the network.

`remote` is the line that matters. A server reachable from the network also accepts browsers on
this machine.

Without `remote`, the server listens only on a loopback address, creates no pairing links, and
signs out devices that paired earlier. It does not start with a host other than a loopback
address or `localhost`. A [background service](./background-service.md) installed before
`IGLO_CODE_LAN` existed keeps private-network access, so without `remote` it refuses to start.
Run `iglo.code up --no-lan` when its `service.env` sets no `IGLO_CODE_HOST`, or set
`IGLO_CODE_HOST=127.0.0.1` in `service.env`, then run `iglo.code service restart`.

When it starts, the server also turns off each Tailscale Serve route, HTTPS or TCP, that forwards
to it, such as one `iglo.code pair --tailscale` set up, and leaves other routes alone. It does not start
while such a route stays on, or while Tailscale's answer cannot be read; the error names the
command that turns the route off. A route whose target is a name, such as `localhost` or another
machine on the same port, also stops it, since a name can resolve to this server; change the route
or iglo.code's port. If Tailscale is installed but does not answer, as on a Mac where it was never set up, the
server does not start until Tailscale is set up or removed. It does start when Tailscale is not
installed, not running, or
logged out, since nothing forwards then; a route Tailscale kept returns when Tailscale runs again,
so restart iglo.code after that.

### Other capabilities

- `webhookTasks: false`: scheduled tasks cannot use webhook triggers. Existing webhook tasks stay
  but do not run, and cannot be turned back on. Users can still edit or delete them.
- `browserCookieImport: false`: users cannot import cookies from another browser into iglo.code's
  browser.
- `telemetry: false`: the server sends no [product usage data](./telemetry.md). A policy cannot
  turn it on.

### Providers

`providers.allowedDrivers` lists the providers that may run, by ID: `codex` (Codex),
`claudeAgent` (Claude), `cursor` (Cursor), `grok` (Grok), `opencode` (OpenCode), `antigravity`
(Antigravity), `fx` (fx), `kiro` (Kiro), `pi` (Pi), `muse` (Muse Code), and `acpRegistry` (ACP
Registry).
`iglo.code policy check` rejects an ID this version does not know. Threads on other providers stay,
marked unavailable, and users can still turn those providers off.

`providers.instances` sets fields on every instance of a provider, such as an environment variable
that routes Claude through Amazon Bedrock or a base URL for a company gateway. `binaryPath` and
`launchArgs` work only for providers that have those settings. With `"locked": true`, users cannot
change the fields you set. With `"locked": false`, the fields fill in only what the user left
empty. A `codex` entry that is locked, or any `codex` entry under `maxRuntimeMode`, also rules out
[Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), since that runtime would skip
your fields. In the same way, an `opencode` entry like that rules out a server URL, so OpenCode
starts the binary you set.

### Updates

- `mode`: `auto` keeps the normal update flow. `off` stops iglo.code from checking for updates, for
  machines that get iglo.code through device management.
- `feedUrl`: iglo.code updates from your own mirror instead of GitHub: `iglo.code update` and updates
  started from the web app. Publish only the versions you have approved. The update files
  that name the version for each platform (`latest-mac.yml`, `latest-linux.yml`,
  `latest-linux-arm64.yml`, and their `nightly-*` versions if you allow nightly) go at the URL's
  root, and the release's `iglo.code-*` archives and `SHA256SUMS` go under `v<version>/`.
- `allowNightly: false`: the nightly channel is unavailable.

## What a policy does not cover

The policy controls what iglo.code does. Agents run through each provider's own CLI, which reads its
own configuration, such as `~/.claude`, and which a user can also run outside iglo.code. To restrict
those CLIs, use their own managed configuration, such as Claude Code's managed settings.

Without `remote`, iglo.code does not expose the server, but a user can still forward its local port
with other tools.

A user with administrator rights on the machine can edit or remove the policy. iglo.code enforces
the policy in its own processes, which run as the user, so it stops users from changing managed
settings in iglo.code but does not stop a user who modifies or replaces iglo.code itself. A version
from before managed policy ignores it too. To control which builds can run, use your device
management tool's application controls.
