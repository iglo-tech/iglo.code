import { useAtomRefresh } from "@effect/atom-react";
import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { createProviderWorkspaceSnapshotRefreshAtomFamily } from "@t3tools/client-runtime/providerSkills";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";

const providerWorkspaceSnapshotRefresh = createProviderWorkspaceSnapshotRefreshAtomFamily({
  providers: serverEnvironment.providersValueAtom,
  refreshProviders: serverEnvironment.refreshProviders,
});

const idleRefreshAtom: Atom.Atom<unknown> = Atom.make<void>(undefined).pipe(
  Atom.withLabel("provider-workspace-snapshot-refresh:idle"),
);

/**
 * Keeps the selected provider's workspace snapshot fresh for the composer's
 * cwd. Each new draft target or skill/slash picker opening asks for a scan
 * newer than the snapshot it started with. Returns a check to run when the
 * user types.
 */
export function useProviderWorkspaceSnapshotRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly composerDraftTargetKey: string;
  readonly workspacePickerOpen: boolean;
}): () => void {
  const { environmentId, gitCwd, instanceId, composerDraftTargetKey, workspacePickerOpen } = input;
  const [pickerOpenCount, setPickerOpenCount] = useState(0);
  const [wasPickerOpen, setWasPickerOpen] = useState(workspacePickerOpen);
  if (wasPickerOpen !== workspacePickerOpen) {
    setWasPickerOpen(workspacePickerOpen);
    if (workspacePickerOpen) setPickerOpenCount((count) => count + 1);
  }
  const atom =
    gitCwd && instanceId
      ? providerWorkspaceSnapshotRefresh({
          environmentId,
          instanceId,
          cwd: gitCwd,
          revalidation: `${composerDraftTargetKey}:${pickerOpenCount}`,
        })
      : idleRefreshAtom;
  return useAtomRefresh(atom);
}
