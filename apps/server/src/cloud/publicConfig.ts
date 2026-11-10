import { CONNECT_OAUTH_SCOPES, DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import type { RelayClientTracingConfig } from "@t3tools/shared/relayTracing";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";

/**
 * iglo.code does not run T3 Connect. No env var or build define configures the relay, Clerk, or
 * the hosted app, so relay or Clerk settings left in the environment for upstream T3 Code cannot
 * turn it on. The dormant Connect code reads only these values.
 */
export const hasCloudPublicConfig: boolean = false;

const connectUnavailable = Config.fail(
  new ConfigProvider.SourceError({ message: "T3 Connect is not available in iglo.code." }),
);

export const relayUrlConfig: Config.Config<string> = connectUnavailable;

export const hostedAppUrlConfig = Config.succeed(DEFAULT_HOSTED_APP_URL);

export const agentApprovalAppUrlConfig = hostedAppUrlConfig;

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CONNECT_OAUTH_SCOPES;
}

export const cloudCliOAuthConfig: Config.Config<CloudCliOAuthConfig> = connectUnavailable;

export function resolveRelayClientTracingConfig(): RelayClientTracingConfig | null {
  return null;
}
