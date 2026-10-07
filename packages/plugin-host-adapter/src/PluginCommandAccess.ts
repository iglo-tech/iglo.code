import type { RuntimeMode, ThreadId } from "@t3tools/contracts";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { DispatchModes } from "../../../apps/server/src/orchestration-v2/DispatchModeLimit.ts";

/** A tool may record a final report after its turn, but native actions need a live caller. */
export class PluginCommandAccess extends Context.Service<
  PluginCommandAccess,
  {
    readonly authorize: (input: {
      readonly runtimeMode?: RuntimeMode;
      readonly threadId?: ThreadId;
    }) => Effect.Effect<DispatchModes, PluginError>;
  }
>()("@t3tools/plugin-host-adapter/PluginCommandAccess") {}
