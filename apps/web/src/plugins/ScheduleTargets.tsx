import type { EnvironmentId } from "@t3tools/contracts";
import { usePluginContributions } from "./PluginSlots";
import type { PluginScheduleTarget } from "./scheduleTargetLogic";

/**
 * Schedule targets usable on one environment: contributed by a compiled client module and
 * published by that environment's plugin. An open editor may retain its contribution while
 * disconnected so its draft stays mounted; the context holds mutations until reconciliation.
 */
export function usePluginScheduleTargets(
  environmentId: EnvironmentId,
  retainWhileDisconnected = false,
) {
  const { contributions, connection, status } = usePluginContributions(environmentId, null, null, {
    retainWhileDisconnected,
  });
  const targets =
    connection !== "connected" && !retainWhileDisconnected
      ? []
      : contributions.flatMap((plugin) =>
          plugin.scheduleTargets
            .filter(
              (target) =>
                target.id.startsWith(`${plugin.manifest.id}.`) &&
                plugin.context.descriptor.manifest.server.scheduleTargets.includes(target.id),
            )
            .map((target): PluginScheduleTarget => ({
              id: target.id,
              pluginId: plugin.manifest.id,
              title: target.title,
              renderEditor: (props) => target.renderEditor(plugin.context, props),
              renderHistory: (props) => target.renderHistory(plugin.context, props),
              save: target.save,
            })),
        );
  // Until the catalog is known, a missing target is unknown rather than unavailable.
  return { targets, status };
}
