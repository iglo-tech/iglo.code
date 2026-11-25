import {
  linkBatchBlockLabel,
  linkBatchCandidates,
  linkBatchFailureLabel,
  type LinkBatchOutcome,
  linkBatchSummary,
  linkListState,
  runLinkBatch,
} from "@t3tools/client-runtime/link-batch";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { T, useGT, useMessages } from "gt-react";
import { RegistryContext } from "@effect/atom-react";
import { useContext, useId, useRef, useState } from "react";

import { useEnvironments } from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const NO_MACHINES: ReadonlySet<EnvironmentId> = new Set();
const NO_OUTCOMES: ReadonlyMap<EnvironmentId, LinkBatchOutcome> = new Map();

export function LinkSeveralEnvironmentsAction({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <T>Link several…</T>
      </Button>
      <LinkSeveralEnvironmentsDialog
        environmentId={environmentId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * Links the machines this app already reaches in one go. Each pairing code is
 * minted on its machine and passed straight to the linking environment; none
 * is ever held in state, shown, or logged.
 */
export function LinkSeveralEnvironmentsDialog({
  environmentId,
  open,
  onOpenChange,
  preset,
  presetOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Machines picked before the dialog opened. Those a batch cannot link stay unticked. */
  readonly preset?: ReadonlyArray<EnvironmentId>;
  /** Lists only the `preset` machines: they were picked for this link, not as a suggestion. */
  readonly presetOnly?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const formId = useId();
  const sourceLabel = useEnvironments().environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.label;
  const known = useLinkableMachines(environmentId, open);
  const machines =
    presetOnly && preset !== undefined
      ? known.filter((machine) => preset.includes(machine.environmentId))
      : known;
  // The same shared list `useLinkableMachines` reads `linked` from.
  const links = useEnvironmentQuery(
    open ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const linksState = linkListState(links);
  const registry = useContext(RegistryContext);
  const writable = useEnvironmentsWithScope(machines, AuthAccessWriteScope);
  const [selected, setSelected] = useState<ReadonlySet<EnvironmentId>>(() => new Set(preset));
  const [outcomes, setOutcomes] = useState(NO_OUTCOMES);
  const [linking, setLinking] = useState(NO_MACHINES);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  // The failure cause holds the request, and with it the code; keep it out of the console.
  const quiet = { reportFailure: false, reportDefect: false };
  const link = useAtomCommand(peerLinkEnvironment.linkInBatch, {
    label: "link several environments",
    ...quiet,
  });
  const candidates = linkBatchCandidates(machines, writable, linksState);
  const selectable = candidates.flatMap(({ machine, blocked }) =>
    blocked === null && outcomes.get(machine.environmentId)?.kind !== "linked" ? [machine] : [],
  );
  const chosen = selectable.filter((machine) => selected.has(machine.environmentId));
  const busy = linking.size > 0;
  const summary = linkBatchSummary(outcomes);
  const oneWay = [...outcomes.values()].filter(
    (outcome) =>
      outcome.kind === "linked" &&
      (outcome.reciprocal?.kind === "failed" || outcome.reciprocal?.kind === "unsupported"),
  ).length;
  // Picked on the map, but only another machine's link names them: this app has no session there.
  const unlisted = (preset ?? []).filter(
    (id) => !candidates.some(({ machine }) => machine.environmentId === id),
  ).length;

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setSelected(NO_MACHINES);
      setOutcomes(NO_OUTCOMES);
    }
  };
  const toggle = (id: EnvironmentId, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = async () => {
    if (inFlight.current || chosen.length === 0) return;
    inFlight.current = true;
    setLinking(new Set(chosen.map((machine) => machine.environmentId)));
    const results = await runLinkBatch({
      machines: chosen,
      mint: mintPairingCodeOn,
      link: async (input) => {
        const result = await link({ environmentId, input });
        return result._tag === "Success"
          ? Result.succeed(result.value)
          : Result.fail(squashAtomCommandFailure(result));
      },
      // Devices follow link names, on this machine and each linked one.
      refreshLinks: () => {
        links.refresh();
        for (const id of [environmentId, ...chosen.map((machine) => machine.environmentId)]) {
          registry.refresh(peerLinkEnvironment.names({ environmentId: id, input: {} }));
        }
      },
      onOutcome: (id, outcome) => {
        setOutcomes((current) => new Map(current).set(id, outcome));
        setLinking((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      },
    });
    inFlight.current = false;
    setLinking(NO_MACHINES);
    // What failed stays picked, so linking again retries only those.
    setSelected(new Set(linkBatchSummary(results).failed));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {sourceLabel === undefined
              ? gt("Link several environments")
              : gt("Link several machines from {source}", { source: sourceLabel })}
          </DialogTitle>
          <DialogDescription>
            <T>
              Agents here can then launch, message and wait on threads on each machine you pick,
              with full access. Each appears under Authorized clients in that machine's Sharing &
              access, where it can be revoked.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {presetOnly ? (
                  <T>This app is not connected to any of the machines you picked.</T>
                ) : (
                  <T>This app knows no other machines. Add them under Environments first.</T>
                )}
              </p>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    <T>Machines</T>
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={busy || selectable.length === 0}
                    onClick={() =>
                      setSelected(
                        chosen.length === selectable.length
                          ? NO_MACHINES
                          : new Set(selectable.map((machine) => machine.environmentId)),
                      )
                    }
                  >
                    {chosen.length === selectable.length && selectable.length > 0
                      ? gt("Select none")
                      : gt("Select all")}
                  </Button>
                </div>
                {linksState === "loaded" ? null : (
                  <div
                    role="status"
                    className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                  >
                    {linksState === "loading" ? (
                      <T>Checking which machines are already linked…</T>
                    ) : (
                      <>
                        <span className="text-destructive">
                          {gt(
                            "Could not check which machines are already linked, so none can be picked: {error}",
                            { error: links.error ?? "" },
                          )}
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={links.isPending}
                          onClick={links.refresh}
                        >
                          <T>Retry</T>
                        </Button>
                      </>
                    )}
                  </div>
                )}
                <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
                  {candidates.map(({ machine, blocked }) => {
                    const id = machine.environmentId;
                    const outcome = outcomes.get(id);
                    const available = blocked === null && outcome?.kind !== "linked";
                    const reciprocal = outcome?.kind === "linked" ? outcome.reciprocal : undefined;
                    const status = linking.has(id)
                      ? gt("Linking…")
                      : outcome?.kind === "linked"
                        ? reciprocal?.kind === "linked"
                          ? gt("Linked both ways", {
                              $context:
                                "status of a machine that was just linked in both directions",
                            })
                          : reciprocal?.kind === "failed" || reciprocal?.kind === "unsupported"
                            ? gt("Linked one way", {
                                $context:
                                  "status of a machine: the link to it was made, the link back from it failed",
                              })
                            : gt("Linked", { $context: "status of a machine that was just linked" })
                        : outcome?.kind === "failed"
                          ? linkBatchFailureLabel(outcome.failure, m)
                          : blocked === null
                            ? null
                            : linkBatchBlockLabel(blocked, m);
                    return (
                      <li key={id}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm has-data-disabled:cursor-default">
                          <Checkbox
                            checked={available && selected.has(id)}
                            disabled={busy || !available}
                            onCheckedChange={(checked) => toggle(id, checked)}
                          />
                          <EnvironmentMachineIcon
                            kind={machine.machine}
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{machine.label}</span>
                            {outcome?.kind === "failed" && outcome.detail !== null ? (
                              <span className="block text-xs text-destructive">
                                {outcome.detail}
                              </span>
                            ) : null}
                            {reciprocal?.kind === "failed" ? (
                              <span className="block text-xs text-destructive">
                                {gt("Could not link back: {reason}", {
                                  reason: reciprocal.message,
                                })}
                              </span>
                            ) : reciprocal?.kind === "unsupported" ? (
                              <span className="block text-xs text-muted-foreground">
                                {gt(
                                  "It runs an iglo.code version that does not link back. Update it there, then link again.",
                                )}
                              </span>
                            ) : null}
                          </span>
                          {status === null ? null : (
                            <span
                              className={
                                outcome?.kind === "failed" || reciprocal?.kind === "failed"
                                  ? "shrink-0 text-xs text-destructive"
                                  : "shrink-0 text-xs text-muted-foreground"
                              }
                            >
                              {status}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {unlisted > 0 ? (
              <p className="text-xs text-muted-foreground">
                {gt(
                  "{count, plural, one {# machine needs a pairing code, so it is not listed.} other {# machines need a pairing code, so they are not listed.}}",
                  { count: unlisted },
                )}
              </p>
            ) : null}
            {outcomes.size > 0 && !busy ? (
              <p role="status" className="text-xs text-muted-foreground">
                {summary.failed.length === 0
                  ? gt("{linked, plural, one {Linked # machine.} other {Linked # machines.}}", {
                      linked: summary.linked,
                    })
                  : gt(
                      "Linked {linked} of {total}. The ones that failed stay selected, so you can try them again.",
                      { linked: summary.linked, total: outcomes.size },
                    )}
                {oneWay > 0
                  ? ` ${gt(
                      "{count, plural, one {# machine could not link back.} other {# machines could not link back.}}",
                      { count: oneWay },
                    )}`
                  : null}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            {outcomes.size > 0 ? gt("Done") : gt("Cancel")}
          </DialogClose>
          {outcomes.size > 0 && !busy && chosen.length === 0 ? null : (
            <Button form={formId} type="submit" disabled={busy || chosen.length === 0}>
              {busy
                ? gt("Linking…")
                : gt("{count, plural, one {Link # machine} other {Link # machines}}", {
                    count: chosen.length,
                  })}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
