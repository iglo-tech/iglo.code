// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Resolve the disk-backed SDK and its adjacent Webpack chunks beside the installed Bun executable.
const requireCursorSdk = NodeModule.createRequire(
  HostProcess.resolveHostModuleUrl(import.meta.url),
);
export const {
  Agent,
  AuthenticationError,
  ConfigurationError,
  createAgentPlatform,
  Cursor,
  CursorSdkError,
  InMemoryCredentialStore,
} = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
export const { SqliteLocalAgentStore } = requireCursorSdk(
  "@cursor/sdk/sqlite",
) as typeof import("@cursor/sdk/sqlite");
