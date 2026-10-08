import { PluginPageState, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Search = Schema.Struct({
  pluginProjectId: Schema.optional(ProjectId),
  pluginThreadId: Schema.optional(ThreadId),
  pluginState: Schema.optional(PluginPageState),
});
const decodeSearch = Schema.decodeUnknownSync(Search);
const decodeState = Schema.decodeUnknownOption(PluginPageState);

/** Plugin page search; invalid or oversized page state is dropped instead of reaching the plugin. */
export const validatePluginSearch = (input: Record<string, unknown>) =>
  decodeSearch({ ...input, pluginState: Option.getOrUndefined(decodeState(input.pluginState)) });
