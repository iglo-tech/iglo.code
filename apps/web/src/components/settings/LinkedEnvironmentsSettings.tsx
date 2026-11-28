import { useAtomValue } from "@effect/atom-react";
import { ANOTHER_ADDRESS, linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import { AuthAccessWriteScope, type EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  linkUnusableFromPage,
  peerLinkHealth,
  type PeerLinkHealth,
} from "@t3tools/client-runtime/state/peerLinks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironment } from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines, useLinkThroughRoutes } from "~/state/peerLinks";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAddressWarning, LinkMachineSelect } from "./LinkMachineSelect";
import { LinkSeveralEnvironmentsAction } from "./LinkSeveralEnvironments";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { m as resolveMessage } from "../../i18n/messages";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useSearchableSetting } from "./settingsSearch";

// Console log labels for the atom commands.
const UNLINK_COMMAND_LABEL = "unlink environment";
const CHECK_COMMAND_LABEL = "check environment link";
const LINK_COMMAND_LABEL = "link environment";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkedEnvironmentsSettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId, input: {} }),
    useMessages(),
  );
  // Links made outside this client bump nothing the shared list reads, so showing the panel
  // asks again. Listing probes every linked environment, too costly for a timer nobody asked for.
  // A list still loading counts as read now, so the next return to the window asks again.
  useLiveRefresh(
    () => {
      if (!links.isPending) links.refresh();
    },
    {
      key: `linked-environments:${environmentId}`,
      intervalMs: null,
      refreshOnShow: true,
    },
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const search = searchableSetting("linked-environments");
  // A batch needs at least two other machines this app has saved.
  const otherMachines = useEnvironments().environments.length - 1;
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={
        canLink ? (
          <div className="flex items-center gap-2">
            {otherMachines > 1 ? (
              <LinkSeveralEnvironmentsAction environmentId={environmentId} />
            ) : null}
            <LinkEnvironmentAction environmentId={environmentId} />
          </div>
        ) : null
      }
    >
      {links.error ? (
        <SettingsRow title={gt("Could not load linked environments")} description={links.error} />
      ) : !links.data ? (
        <SettingsRow title={gt("Loading linked environments…")} role="status" />
      ) : links.data.links.length === 0 ? (
        <SettingsRow
          title={gt("No linked environments")}
          description={gt(
            "Link another machine running iglo.code, such as a VPS, so agents here can launch and drive threads there.",
          )}
        />
      ) : (
        links.data.links.map((link) => (
          <LinkedEnvironmentRow
            key={link.environmentId}
            environmentId={environmentId}
            link={link}
          />
        ))
      )}
    </SettingsSection>
  );
}

function LinkedEnvironmentRow({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const { busy, forget } = useForgetPeerLink(environmentId, link);
  const checking = useCheckPeerLink(environmentId, link);
  const status = peerLinkStatusText(health, gt);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={status}
              dotClassName={
                health.kind === "reachable"
                  ? health.expiresInDays === null
                    ? "bg-success"
                    : "bg-warning"
                  : health.kind === "expired" || health.kind === "failing"
                    ? "bg-destructive"
                    : "bg-muted-foreground/30"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {link.access === "full-access"
              ? status
              : `${m(accessConfig[link.access].label)} · ${status}`}
          </p>
          <p className="truncate text-xs text-muted-foreground/80">{link.urls.join(", ")}</p>
          <LinkUnusableFromPageNote link={link} />
        </div>
        {canUnlink || checking.canCheck ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {checking.canCheck ? (
              <Button
                size="xs"
                variant="outline"
                disabled={checking.busy}
                onClick={() => void checking.check()}
              >
                {checking.busy ? gt("Checking…") : gt("Check now")}
              </Button>
            ) : null}
            {canUnlink ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void forget()}
              >
                {busy ? gt("Forgetting…") : gt("Forget")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinkEnvironmentAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <LinkEnvironmentDialog
      environmentId={environmentId}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              {gt("Link", { $context: "verb, links an environment" })}
            </Button>
          }
        />
      }
    />
  );
}

/** What the link dialog opens with when something other than its own button opened it. */
export interface LinkEnvironmentPrefill {
  /** The machine to link to, by environment id, or `ANOTHER_ADDRESS` with `address`. */
  readonly choice: string | null;
  readonly address?: string;
  /**
   * With `address`: the machine there, and one of this app's that links to it at full access and
   * so can get the pairing code from it.
   */
  readonly through?: {
    readonly viaEnvironmentId: EnvironmentId;
    readonly environmentId: EnvironmentId;
    readonly label: string;
  };
}

/**
 * The one link flow. When this client is connected to the picked machine and may create pairing
 * links there, it mints the code itself; otherwise it asks for one.
 */
export function LinkEnvironmentDialog({
  environmentId,
  open,
  onOpenChange,
  trigger = null,
  prefill,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger?: ReactNode;
  readonly prefill?: LinkEnvironmentPrefill;
}) {
  const gt = useGT();
  const setOpen = onOpenChange;
  // Named in the title: from the map, nothing else on screen says which machine is linking.
  const source = useEnvironment(environmentId);
  const saved = useLinkableMachines(environmentId, open);
  const routes = useLinkThroughRoutes(environmentId, open);
  // Machines this app has no entry for are still pickable when one of its environments links
  // to them at full access.
  const machines = [
    ...saved,
    ...[...routes.values()]
      .filter((route) => saved.every((machine) => machine.environmentId !== route.environmentId))
      .map((route) => ({
        environmentId: route.environmentId,
        label: route.label,
        machine: "server" as const,
        connected: false,
        connectOnly: false,
        linked: false,
        urls: route.urls,
      })),
  ];
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(prefill?.choice ?? null);
  const [address, setAddress] = useState(prefill?.address ?? "");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: LINK_COMMAND_LABEL });
  const pairThrough = useAtomCommand(peerLinkEnvironment.pairLink, {
    label: "pair link through a linked environment",
    // The answer is a credential; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  // Machines that would not give a code through a link, so the dialog asks for one instead.
  const [throughFailed, setThroughFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  // Only for the machine the dialog opened for: another choice or address is another machine.
  const prefilledThrough =
    prefill?.through !== undefined &&
    selected === ANOTHER_ADDRESS &&
    address === (prefill.address ?? "")
      ? prefill.through
      : null;
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  // A picked machine that left the list has no address here either.
  const needsAddress = selected !== null && (machine === null || machine.urls.length === 0);
  // This client mints a code there when it is connected with a session that may
  // create pairing links, and only for its own addresses: anything can answer
  // as that machine at one typed in, so that one gets a code the user fetched.
  const canMint =
    targetId !== null &&
    !needsAddress &&
    Option.isSome(connected) &&
    mayMint &&
    !mintFailed.has(targetId);
  // Minting with this client's own session there comes first: it needs no third machine.
  const throughCandidate =
    prefilledThrough ?? (targetId === null || canMint ? null : (routes.get(targetId) ?? null));
  const via = useEnvironment(throughCandidate?.viaEnvironmentId ?? null);
  // The environment holding the link refuses a level this client's session there does not hold.
  const mayPairThrough = useAtomValue(
    peerLinkEnvironment.pairLink.permissionAtom(
      throughCandidate?.viaEnvironmentId ?? null,
      throughCandidate === null ? undefined : { environmentId: throughCandidate.environmentId },
    ),
  );
  const through =
    throughCandidate !== null &&
    via !== null &&
    mayPairThrough &&
    !throughFailed.has(throughCandidate.environmentId)
      ? throughCandidate
      : null;
  const ready =
    through !== null ||
    (selected !== null &&
      (!needsAddress || address.trim().length > 0) &&
      (canMint || pairingCode.trim().length > 0));
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(prefill?.choice ?? null);
      setAddress(prefill?.address ?? "");
      setPairingCode("");
      setMintFailed(new Set());
      setThroughFailed(new Set());
    }
  };
  // Settles to what to link with, or null after reporting why the linked machine gave no code.
  const resolveThrough = async (target: NonNullable<typeof through>) => {
    const asked = await pairThrough({
      environmentId: target.viaEnvironmentId,
      input: { environmentId: target.environmentId, access: "full-access" },
    });
    if (asked._tag === "Success" && asked.value.type === "credential") {
      const [url, ...alternateUrls] = asked.value.urls;
      if (url !== undefined) {
        return {
          url,
          ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
          expectedEnvironmentId: asked.value.environmentId,
          expectedLabel: asked.value.label,
          pairingCode: asked.value.credential,
          access: "full-access" as const,
          reciprocal: true,
        };
      }
    }
    if (asked._tag === "Failure" && isAtomCommandInterrupted(asked)) return null;
    setThroughFailed((failed) => new Set(failed).add(target.environmentId));
    failureToast(
      gt("{via} could not get a pairing code from {target}", {
        via: via?.label ?? "",
        target: target.label,
      }),
      gt("Enter its address and a pairing code from it instead."),
    );
    return null;
  };
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast(
      gt("Could not link the environment"),
      linkRequestFailureMessage(minted.failure, resolveMessage),
    );
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const throughInput = through === null ? null : await resolveThrough(through);
    const code = through === null ? await resolvePairingCode() : null;
    const result =
      through !== null
        ? throughInput === null
          ? null
          : await link({ environmentId, input: throughInput })
        : code === null
          ? null
          : await link({
              environmentId,
              input: {
                url,
                ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
                // A typed address links alone: only this app's own addresses name a machine.
                ...(machine === null || needsAddress
                  ? {}
                  : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
                pairingCode: code,
                access: "full-access",
                reciprocal: true,
              },
            });
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      const reciprocal = result.value.reciprocal;
      toastManager.add({
        type: "success",
        title:
          reciprocal?.kind === "linked" && source !== null
            ? gt("Linked {source} and {target} both ways", {
                source: source.label,
                target: result.value.label,
              })
            : gt("Linked {label}", { label: result.value.label }),
      });
      // The link stands whatever came of the link back, so say so.
      if (reciprocal?.kind === "failed") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: gt("Linked {target} one way", { target: result.value.label }),
            description: reciprocal.message,
          }),
        );
      } else if (reciprocal?.kind === "unsupported") {
        toastManager.add({
          type: "info",
          title: gt("Linked {target} one way", { target: result.value.label }),
          description: gt(
            "It runs an iglo.code version that does not link back. Update it there, then link again.",
          ),
        });
      }
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not link the environment"), String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      {trigger}
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {source === null ? (
              <T>Link an environment</T>
            ) : through !== null ? (
              gt("Link {source} to {target}", { source: source.label, target: through.label })
            ) : machine === null ? (
              gt("Link {label} to another machine", { label: source.label })
            ) : (
              gt("Link {source} to {target}", { source: source.label, target: machine.label })
            )}
          </DialogTitle>
          <DialogDescription>
            <T>
              Agents here can then launch, message and wait on threads there, with full access. It
              appears under Authorized clients in that environment's Sharing & access, where it can
              be revoked.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 && (through === null || through !== prefilledThrough) ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={setChoice}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                <T>Already linked. Linking again renews it.</T>
              </p>
            ) : null}
            {through !== null ? (
              <p className="text-xs text-muted-foreground">
                {gt("{via} is linked to {target}, so it gets the pairing code. No code to paste.", {
                  via: via?.label ?? "",
                  target: through.label,
                })}
              </p>
            ) : null}
            {needsAddress && through === null ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Address</T>
                </span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      This app has no address for <Var>{machine.label}</Var> that another machine
                      can reach. Enter its https or Tailscale address.
                    </T>
                  </span>
                ) : null}
              </label>
            ) : null}
            {needsAddress && through === null && address.trim() ? (
              <LinkAddressWarning address={address} />
            ) : null}
            {selected === null || canMint || through !== null ? null : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Pairing code</T>
                </span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null
                      ? gt("From Sharing & access there, or iglo.code pair")
                      : gt("Paste the code")
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      Create a link on <Var>{machine.label}</Var>: Settings → Sharing & access →
                      Authorized clients → Create link, then paste its code here.
                    </T>
                  </span>
                ) : null}
              </label>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? gt("Linking…") : gt("Link", { $context: "verb, links an environment" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** What a link's health means for the user, in a sentence. */
export function peerLinkStatusText(health: PeerLinkHealth, gt: ReturnType<typeof useGT>): string {
  return health.kind === "expired"
    ? gt("Expired. Link it again with a new pairing code.")
    : health.kind === "unreachable"
      ? (health.detail ?? gt("Not answering right now."))
      : health.kind === "failing"
        ? health.detail
        : health.expiresInDays !== null
          ? gt(
              "{days, plural, one {Expires in {days} day. Link it again to renew.} other {Expires in {days} days. Link it again to renew.}}",
              { days: health.expiresInDays },
            )
          : gt("Reachable");
}

/** Checks `link` from `environmentId` now; the list shows what came of it. */
export function useCheckPeerLink(environmentId: EnvironmentId, link: PeerLinkSummary) {
  const gt = useGT();
  const run = useAtomCommand(peerLinkEnvironment.check, { label: CHECK_COMMAND_LABEL });
  const canCheck = useAtomValue(peerLinkEnvironment.check.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const result = await run({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not check the link"), String(squashAtomCommandFailure(result)));
    }
  };
  return { canCheck, busy, check };
}

/** Says when this page cannot open any of a link's addresses, which hides that machine here. */
export function LinkUnusableFromPageNote({ link }: { readonly link: PeerLinkSummary }) {
  const gt = useGT();
  // A machine this browser reaches on a route of its own shows here anyway.
  const connected = useEnvironment(link.environmentId)?.connection.phase === "connected";
  if (
    connected ||
    typeof window === "undefined" ||
    !linkUnusableFromPage(link, window.location.protocol)
  ) {
    return null;
  }
  return (
    <p className="text-xs text-warning">
      {gt(
        "This page uses https, so this browser cannot open {label}''s plain-http addresses, and its projects do not show here. Serve {label} over https (Tailscale Serve), then check the link.",
        { label: link.label },
      )}
    </p>
  );
}

/** Forgets `link` from `environmentId` after the user confirms. */
export function useForgetPeerLink(environmentId: EnvironmentId, link: PeerLinkSummary) {
  const gt = useGT();
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: UNLINK_COMMAND_LABEL });
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      gt(
        "Forget {label}? Agents here stop working there, their session on {label} ends too if it answers, and devices that joined {label} through this link leave it.",
        { label: link.label },
      ),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.removed && result.value.endedThere !== true) {
        toastManager.add({
          type: "warning",
          title: gt("{label} did not answer", { label: link.label }),
          description: gt(
            "Revoke \"iglo.code · …\" in {label}''s Sharing & access to end the session there too.",
            { label: link.label },
          ),
        });
      }
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not forget the link"), String(squashAtomCommandFailure(result)));
    }
  };
  return { busy, forget };
}
