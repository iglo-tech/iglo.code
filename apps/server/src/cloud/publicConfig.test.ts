import { assert, it } from "@effect/vitest";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  cloudCliOAuthConfig,
  hasCloudPublicConfig,
  hostedAppUrlConfig,
  relayUrlConfig,
} from "./publicConfig.ts";

it.effect("ignores upstream T3 Connect configuration in the environment", () =>
  Effect.gen(function* () {
    const relayUrl = yield* Effect.result(relayUrlConfig);
    const oauth = yield* Effect.result(cloudCliOAuthConfig);

    assert.isFalse(hasCloudPublicConfig);
    assert.isTrue(Result.isFailure(relayUrl));
    assert.isTrue(Result.isFailure(oauth));
    assert.equal(yield* hostedAppUrlConfig, DEFAULT_HOSTED_APP_URL);
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_RELAY_URL: "https://relay.t3.codes",
            T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
            T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
            T3CODE_HOSTED_APP_URL: "https://nightly.app.t3.codes",
          },
        }),
      ),
    ),
  ),
);
