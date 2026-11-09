import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import type { RelayClientTracingConfig } from "@t3tools/shared/relayTracing";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("clerkJwtTemplate"),
  },
) {
  override get message(): string {
    return "T3 Connect is not available in iglo.code.";
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

/** iglo.code does not run T3 Connect, so no build or runtime value configures the relay or Clerk. */
export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: null,
    clerkJwtTemplate: null,
    relayUrl: null,
    relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
  };
}

export function resolveRelayTracingConfig(): RelayClientTracingConfig | null {
  return null;
}

export function hasCloudPublicConfig(): boolean {
  return false;
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "clerkJwtTemplate" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}
