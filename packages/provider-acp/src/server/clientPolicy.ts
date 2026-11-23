// @effect-diagnostics nodeBuiltinImport:off
import type { RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface AcpRuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
  readonly workspace?: { readonly extraRoots: ReadonlyArray<string> } | undefined;
}

export type AcpPermissionDisposition = "allow" | "ask" | "deny";

export interface AcpPermissionPolicyOptions {
  readonly readOnlyPluginTools?: ReadonlyArray<string> | undefined;
}

const ACP_T3_QUALIFIED_MCP_PATTERNS = [
  /^Run mcp_iglo-code_(?<tool>[A-Za-z0-9_]+)\??$/,
  /^mcp__(?:iglo[-_ ]?code|editor_iglo_?code_[0-9a-f]{8})__(?<tool>[A-Za-z0-9_]+)$/i,
  /^@iglo-code\/(?<tool>[A-Za-z0-9_]+)(?::.*)?$/i,
  /^(?<tool>[A-Za-z0-9_]+) \(iglo[-_ ]?code MCP Server\)(?::|$)/i,
] as const;

/** Matches only server-qualified `iglo-code` MCP calls listed in `readOnlyPluginTools`. */
export function isAcpAllowedReadOnlyPluginTool(
  request: EffectAcpSchema.RequestPermissionRequest,
  readOnlyPluginTools?: ReadonlyArray<string>,
): boolean {
  if (readOnlyPluginTools === undefined || readOnlyPluginTools.length === 0) return false;
  const allowed = new Set(readOnlyPluginTools);
  const rawInput = unknownRecord(request.toolCall.rawInput);
  if (typeof rawInput?.CommandLine === "string") return false;
  const meta = unknownRecord(request.toolCall._meta);
  if (rawInput?.ServerName !== undefined) {
    return (
      rawInput.ServerName === "iglo-code" &&
      typeof rawInput.ToolName === "string" &&
      allowed.has(rawInput.ToolName)
    );
  }
  if (meta?.is_mcp_tool_call === true && typeof rawInput?.server === "string") {
    return (
      rawInput.server === "iglo-code" &&
      typeof rawInput.tool === "string" &&
      allowed.has(rawInput.tool)
    );
  }
  const kiroServer = unknownRecord(meta?.kiro)?.serverName;
  if (typeof kiroServer === "string") {
    return (
      kiroServer === "iglo-code" &&
      typeof rawInput?.tool_id === "string" &&
      rawInput.tool_id.startsWith("iglo-code::") &&
      allowed.has(rawInput.tool_id.slice("iglo-code::".length))
    );
  }
  const metaServerId = typeof meta?.serverId === "string" ? meta.serverId.trim() : "";
  const gooseToolCall = unknownRecord(unknownRecord(meta?.goose)?.toolCall);
  const gooseExtension =
    typeof gooseToolCall?.extensionName === "string" ? gooseToolCall.extensionName.trim() : "";
  if (
    (metaServerId.length > 0 && !/^iglo[-_ ]?code$/i.test(metaServerId)) ||
    (gooseExtension.length > 0 && !/^iglo[-_ ]?code$/i.test(gooseExtension))
  ) {
    return false;
  }
  if (/^iglo[-_ ]?code$/i.test(metaServerId) && typeof meta?.toolName === "string") {
    const toolName = meta.toolName.trim();
    for (const candidate of allowed) {
      const boundary = toolName.length - candidate.length - 1;
      if (
        toolName === candidate ||
        (toolName.endsWith(candidate) &&
          boundary >= 0 &&
          !/[A-Za-z0-9]/.test(toolName.charAt(boundary)))
      ) {
        return true;
      }
    }
    return false;
  }
  const candidates = [
    meta?.toolName,
    unknownRecord(meta?.claudeCode)?.toolName,
    gooseToolCall?.toolName,
    request.toolCall.title,
  ].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    for (const pattern of ACP_T3_QUALIFIED_MCP_PATTERNS) {
      const tool = pattern.exec(trimmed)?.groups?.tool;
      if (tool !== undefined && allowed.has(tool)) return true;
    }
  }
  return false;
}

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveAcpPermissionPath(path: string, cwd: string | null): string | undefined {
  const trimmed = path.trim();
  if (trimmed.length === 0) return undefined;
  if (NodePath.isAbsolute(trimmed)) return trimmed;
  if (cwd === null || cwd.trim().length === 0) return undefined;
  return `${cwd}${cwd.endsWith(NodePath.sep) ? "" : NodePath.sep}${trimmed}`;
}

function acpPathIsWithinRoot(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

// Canonicalize existing ancestors for symlink-aware checks of new paths; fail closed on errors.
function acpCanonicalPathForContainment(path: string): string | undefined {
  // realpath must resolve symlinks before ..; lexical normalization can hide traversal.
  let candidate = path;
  const missingSuffix: Array<string> = [];

  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    const parent = NodePath.dirname(candidate);
    if (parent === candidate) return undefined;
    missingSuffix.unshift(NodePath.basename(candidate));
    candidate = parent;
  }
}

interface AcpPolicyOperation {
  readonly kind: string | null | undefined;
  readonly locations: ReadonlyArray<{ readonly path: string }> | null | undefined;
}

function acpPolicyRequiresApproval(runtimePolicy: AcpRuntimePolicy): boolean {
  return runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "approval-required"
    : runtimePolicy.approvalPolicy !== "never";
}

function isAcpReadKind(toolKind: string): boolean {
  return toolKind === "read" || toolKind === "search" || toolKind === "think";
}

/** Reads never ask; an absent sandbox implies read-only in approval-required mode. */
function acpReadDisposition(runtimePolicy: AcpRuntimePolicy): "allow" | "deny" {
  switch (unknownRecord(runtimePolicy.sandboxPolicy)?.type) {
    case undefined:
    case "readOnly":
    case "workspaceWrite":
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    default:
      return "deny";
  }
}

function acpWorkspaceWriteAllowsMutation(
  runtimePolicy: AcpRuntimePolicy,
  sandboxPolicy: Record<string, unknown>,
  locations: AcpPolicyOperation["locations"],
): boolean {
  const cwd =
    typeof runtimePolicy.cwd === "string" && runtimePolicy.cwd.trim().length > 0
      ? (resolveAcpPermissionPath(runtimePolicy.cwd, process.cwd()) ?? null)
      : null;
  const roots: Array<string> = [];
  if (cwd !== null) {
    const canonicalCwd = acpCanonicalPathForContainment(cwd);
    if (canonicalCwd !== undefined) roots.push(canonicalCwd);
  }
  const writableRoots = [
    ...(Array.isArray(sandboxPolicy.writableRoots) ? sandboxPolicy.writableRoots : []),
    ...(runtimePolicy.workspace?.extraRoots ?? []),
  ];
  for (const writableRoot of writableRoots) {
    if (typeof writableRoot !== "string") continue;
    const resolved = resolveAcpPermissionPath(writableRoot, cwd);
    if (resolved === undefined) continue;
    const canonicalRoot = acpCanonicalPathForContainment(resolved);
    if (canonicalRoot !== undefined) roots.push(canonicalRoot);
  }
  if (roots.length === 0) return false;

  if (locations === undefined || locations === null || locations.length === 0) {
    return false;
  }
  for (const location of locations) {
    const resolved = resolveAcpPermissionPath(location.path, cwd);
    const canonicalPath =
      resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
    if (
      canonicalPath === undefined ||
      !roots.some((root) => acpPathIsWithinRoot(canonicalPath, root))
    ) {
      return false;
    }
  }
  return true;
}

function acpOperationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  operation: AcpPolicyOperation,
): AcpPermissionDisposition {
  const toolKind = operation.kind ?? "other";
  if (isAcpReadKind(toolKind)) {
    return acpReadDisposition(runtimePolicy);
  }
  if (acpPolicyRequiresApproval(runtimePolicy)) {
    return "ask";
  }

  const sandboxPolicy = unknownRecord(runtimePolicy.sandboxPolicy);
  switch (sandboxPolicy?.type) {
    case "readOnly":
      return "deny";
    case "workspaceWrite":
      if (isAcpMutationKind(toolKind)) {
        return acpWorkspaceWriteAllowsMutation(
          runtimePolicy,
          sandboxPolicy ?? {},
          operation.locations,
        )
          ? "allow"
          : "deny";
      }
      return "deny";
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    case undefined:
      if (runtimePolicy.runtimeMode === "approval-required") return "deny";
      if (
        runtimePolicy.runtimeMode === "auto-accept-edits" &&
        runtimePolicy.approvalPolicy === undefined &&
        !isAcpMutationKind(toolKind)
      ) {
        return "ask";
      }
      return "allow";
    default:
      return "deny";
  }
}

function isAcpMutationKind(toolKind: string): boolean {
  return toolKind === "edit" || toolKind === "delete" || toolKind === "move";
}

export function acpPermissionDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
  options?: AcpPermissionPolicyOptions,
): AcpPermissionDisposition {
  if (isAcpAllowedReadOnlyPluginTool(request, options?.readOnlyPluginTools)) {
    return "allow";
  }
  return acpOperationDisposition(runtimePolicy, {
    kind: request.toolCall.kind,
    locations: request.toolCall.locations,
  });
}

export function acpMcpToolApprovalElicitationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.CreateElicitationRequest,
  nativeRequestId?: string,
  options?: AcpPermissionPolicyOptions,
): "ask" | "allow" | undefined {
  const meta = unknownRecord(request._meta);
  if (
    request.mode !== "form" ||
    (meta?.codex_approval_kind !== "mcp_tool_call" &&
      nativeRequestId?.startsWith("mcp_tool_call_approval_") !== true)
  ) {
    return undefined;
  }
  const server = meta?.server ?? meta?.server_name ?? meta?.serverName;
  const tool = meta?.tool ?? meta?.tool_name ?? meta?.toolName;
  if (
    server === "iglo-code" &&
    typeof tool === "string" &&
    options?.readOnlyPluginTools?.includes(tool) === true
  ) {
    return "allow";
  }
  // T3's authenticated MCP endpoint enforces scope; only explicit approval mode needs a user prompt.
  return acpPolicyRequiresApproval(runtimePolicy) ? "ask" : "allow";
}

export function acpClientExecuteDisposition(
  runtimePolicy: AcpRuntimePolicy,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "execute", locations: undefined });
}

export interface AcpApprovalGrantInput {
  /** The approved request's ACP tool kind, after ID-only requests take their tracked call's kind. */
  readonly toolKind: string;
  readonly scope: "session" | "turn";
  readonly turnKey: string;
}

export interface AcpClientPolicyGrants {
  readonly recordApproval: (input: AcpApprovalGrantInput) => void;
  readonly allowsExecute: (turnKey: string | null) => boolean;
}

/** ACP cannot link commands to terminals; approved execute requests grant execution for the turn or accepted session. */
export function makeAcpClientPolicyGrants(): AcpClientPolicyGrants {
  let sessionExecute = false;
  let turnExecute: string | null = null;
  return {
    recordApproval: (input) => {
      // Other kinds also show as command cards, but approving them must not open terminals.
      if (input.toolKind !== "execute") return;
      if (input.scope === "session") {
        sessionExecute = true;
      } else {
        turnExecute = input.turnKey;
      }
    },
    allowsExecute: (turnKey) => sessionExecute || (turnKey !== null && turnExecute === turnKey),
  };
}
