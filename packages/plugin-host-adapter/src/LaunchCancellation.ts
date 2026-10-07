import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Adapter-only hook: every client must persist cancellation before stopping a pending launch. */
export class LaunchCancellation extends Context.Service<
  LaunchCancellation,
  { readonly beforeCancel: Effect.Effect<boolean> }
>()("@t3tools/plugin-host-adapter/LaunchCancellation") {}
