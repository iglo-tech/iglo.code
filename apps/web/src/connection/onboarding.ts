import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { linkedAutoConnectStore } from "./linkedAutoConnectStore";
import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

type PairingInput = ConnectionOnboarding.PairingConnectionInput & {
  /** Joined through a link, not paired by hand: the link, not the user, holds it here. */
  readonly viaLink?: boolean;
};

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: PairingInput) => JSON.stringify(input),
  },
  execute: ({ viaLink, ...input }: PairingInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
      // Paired by hand, the machine is this device's own: no link going takes it away.
      Effect.tap((environmentId) =>
        viaLink === true
          ? Effect.void
          : Effect.sync(() => linkedAutoConnectStore.own(environmentId)),
      ),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
      Effect.tap((environmentId) => Effect.sync(() => linkedAutoConnectStore.own(environmentId))),
    ),
});

export const reachesEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:reaches-environment",
  execute: (input: { readonly host: string; readonly environmentId: EnvironmentId }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.reaches(input)),
    ),
});
