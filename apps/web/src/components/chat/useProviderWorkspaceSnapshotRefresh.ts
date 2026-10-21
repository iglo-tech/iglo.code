import { type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { type ProviderInstanceEntry } from "../../providerInstances";
import { hasCompleteProviderWorkspaceSnapshot } from "@t3tools/client-runtime/providerSkills";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;

/**
 * Keeps the selected provider's workspace snapshot fresh for the composer's
 * cwd. Each new draft target or skill/slash picker opening asks for a scan
 * newer than the snapshot it started with. Returns a check to run when the
 * user types.
 */
export function useProviderWorkspaceSnapshotRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly selectedProviderEntry: ProviderInstanceEntry | undefined;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly composerDraftTargetKey: string;
  readonly workspacePickerOpen: boolean;
}) {
  const {
    environmentId,
    gitCwd,
    selectedProviderEntry,
    selectedProviderStatus,
    composerDraftTargetKey,
    workspacePickerOpen,
  } = input;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const workspaceRefreshKeyRef = useRef<string | null>(null);
  const workspacePreviousCheckedAtRef = useRef<string | undefined>(undefined);
  const workspaceBoundaryRef = useRef({ key: "", pickerOpen: false, generation: 0 });
  const [workspaceRefreshRetry, setWorkspaceRefreshRetry] = useState<{
    key: string;
    generation: number;
    notBefore: number;
  } | null>(null);
  const workspaceRefreshScopeKey =
    gitCwd && selectedProviderEntry
      ? `${environmentId}:${selectedProviderEntry.instanceId}:${gitCwd}`
      : null;
  const workspaceSlashCommandsPending =
    selectedProviderStatus?.workspaceSnapshots?.some(
      (snapshot) => snapshot.cwd === gitCwd && snapshot.slashCommandsPending === true,
    ) ?? false;
  useEffect(() => {
    if (
      !workspaceSlashCommandsPending ||
      !workspaceRefreshRetry ||
      workspaceRefreshRetry.key !== workspaceRefreshScopeKey
    )
      return;
    const timeout = setTimeout(
      () => {
        setWorkspaceRefreshRetry((current) => (current === workspaceRefreshRetry ? null : current));
      },
      Math.max(0, workspaceRefreshRetry.notBefore - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [workspaceRefreshRetry, workspaceRefreshScopeKey, workspaceSlashCommandsPending]);
  // Losing a snapshot (the server dropped it) lifts the retry cooldown so the
  // next check rescans at once.
  const hasWorkspaceSnapshot = hasCompleteProviderWorkspaceSnapshot(selectedProviderStatus, gitCwd);
  const [hadWorkspaceSnapshot, setHadWorkspaceSnapshot] = useState(hasWorkspaceSnapshot);
  const [workspaceSnapshotLossCount, setWorkspaceSnapshotLossCount] = useState(0);
  if (hadWorkspaceSnapshot !== hasWorkspaceSnapshot) {
    setHadWorkspaceSnapshot(hasWorkspaceSnapshot);
    if (!hasWorkspaceSnapshot) {
      setWorkspaceSnapshotLossCount((count) => count + 1);
      setWorkspaceRefreshRetry(null);
    }
  }
  const lastWorkspaceSnapshotLossRef = useRef(workspaceSnapshotLossCount);
  const refreshWorkspaceSnapshotIfNeeded = (
    scopeKey: string | null,
    draftTargetKey: string,
    pickerOpen: boolean,
    pendingRetry: { key: string; generation: number; notBefore: number } | null,
    snapshotLossCount: number,
  ) => {
    if (lastWorkspaceSnapshotLossRef.current !== snapshotLossCount) {
      lastWorkspaceSnapshotLossRef.current = snapshotLossCount;
      workspaceRefreshKeyRef.current = null;
    }
    const boundaryKey = JSON.stringify([scopeKey, draftTargetKey]);
    const boundary = workspaceBoundaryRef.current;
    if (boundary.key !== boundaryKey || (pickerOpen && !boundary.pickerOpen)) {
      // A retry from an earlier boundary no longer applies; the generation
      // retires it without a state update.
      workspaceRefreshKeyRef.current = null;
      workspacePreviousCheckedAtRef.current = selectedProviderStatus?.workspaceSnapshots?.find(
        (snapshot) => snapshot.cwd === gitCwd,
      )?.checkedAt;
      boundary.generation += 1;
    }
    boundary.key = boundaryKey;
    boundary.pickerOpen = pickerOpen;
    const generation = boundary.generation;
    if (scopeKey === null || !gitCwd || !selectedProviderEntry) return;
    if (workspaceRefreshKeyRef.current === scopeKey) return;
    const retry =
      pendingRetry?.key === scopeKey && pendingRetry.generation === generation
        ? pendingRetry
        : null;
    if (
      retry &&
      hasCompleteProviderWorkspaceSnapshot(
        selectedProviderStatus,
        gitCwd,
        workspacePreviousCheckedAtRef.current,
      )
    ) {
      workspaceRefreshKeyRef.current = scopeKey;
      return;
    }
    if (retry && Date.now() < retry.notBefore) return;
    workspaceRefreshKeyRef.current = scopeKey;
    const previousCheckedAt = workspacePreviousCheckedAtRef.current;
    const retryLater = () => {
      if (workspaceBoundaryRef.current.generation !== generation) return;
      if (workspaceRefreshKeyRef.current !== scopeKey) return;
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry({
        key: scopeKey,
        generation,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      });
    };
    void refreshProviders({
      environmentId,
      input: { instanceId: selectedProviderEntry.instanceId, cwd: gitCwd },
    }).then((result) => {
      const refreshedSnapshot =
        result._tag === "Success" &&
        hasCompleteProviderWorkspaceSnapshot(
          result.value.providers.find(
            (provider) => provider.instanceId === selectedProviderEntry.instanceId,
          ),
          gitCwd,
          previousCheckedAt,
        );
      if (!refreshedSnapshot) retryLater();
    }, retryLater);
  };
  const refreshWorkspaceSnapshotOnChange = useEffectEvent(refreshWorkspaceSnapshotIfNeeded);
  useEffect(() => {
    refreshWorkspaceSnapshotOnChange(
      workspaceRefreshScopeKey,
      composerDraftTargetKey,
      workspacePickerOpen,
      workspaceRefreshRetry,
      workspaceSnapshotLossCount,
    );
  }, [
    workspaceRefreshScopeKey,
    composerDraftTargetKey,
    workspacePickerOpen,
    workspaceRefreshRetry,
    workspaceSnapshotLossCount,
  ]);
  return useStableCallback(() =>
    refreshWorkspaceSnapshotIfNeeded(
      workspaceRefreshScopeKey,
      composerDraftTargetKey,
      workspacePickerOpen,
      workspaceRefreshRetry,
      workspaceSnapshotLossCount,
    ),
  );
}
