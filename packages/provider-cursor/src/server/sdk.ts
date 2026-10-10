// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// Resolve the SDK beside the installed Bun executable, including its chunks.
const requireCursorSdk = NodeModule.createRequire(
  HostProcess.resolveHostModuleUrl(import.meta.url),
);
export const {
  Agent,
  AuthenticationError,
  createAgentPlatform,
  Cursor,
  CursorSdkError,
  InMemoryCredentialStore,
} = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
