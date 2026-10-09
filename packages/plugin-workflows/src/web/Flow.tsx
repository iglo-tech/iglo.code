import { RefreshCwIcon } from "lucide-react";
import type { Capabilities, Node } from "../contracts.ts";
import type { PageProps } from "./common.tsx";
import { editableKinds, kindLabels, type EditableKind } from "./editing.ts";
import { KindIcon } from "./kinds.tsx";

/**
 * The focus target for a step (or reviewer lane) box. Step identities are already safe; lane
 * ids carry a `/` that is escaped injectively, so `reviews/code` never meets `reviews-code`.
 */
export const stepButtonId = (nodeId: string) =>
  `wf-step-${nodeId.replace(/[^a-zA-Z0-9-]/g, (char) =>
    char === "_" ? "__" : `_x${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}`;
/**
 * Add a step: only kinds this client authors and the environment advertises are enabled; the
 * rest stay visible with the reason on hover. Until capabilities load, only agent steps and
 * ends (which every backend runs) are offered.
 */
export function Palette({
  props,
  capabilities,
  capabilitiesError,
  onRetryCapabilities,
  disabled,
  onAdd,
}: {
  readonly props: PageProps;
  readonly capabilities: Capabilities | null;
  readonly capabilitiesError: string | null;
  readonly onRetryCapabilities: () => void;
  readonly disabled: boolean;
  readonly onAdd: (kind: EditableKind) => void;
}) {
  const { Button } = props;
  const advertised = capabilities?.nodeKinds;
  return (
    <nav aria-label="Add a step" className="flex flex-col gap-0.5">
      {(Object.keys(kindLabels) as Array<Node["kind"]>).map((kind) => {
        const basic = kind === "agent" || kind === "end";
        const supported = advertised === undefined ? basic : advertised.includes(kind);
        const authored = (editableKinds as ReadonlyArray<string>).includes(kind);
        const reason = !authored
          ? "Not editable in this version"
          : advertised === undefined && !basic
            ? "Loading step types…"
            : !supported
              ? "Not supported by this environment"
              : undefined;
        return (
          <Button
            key={kind}
            variant="ghost"
            size="row"
            disabled={disabled || reason !== undefined}
            {...(reason === undefined ? {} : { tooltip: reason })}
            onClick={() => onAdd(kind as EditableKind)}
          >
            <KindIcon kind={kind} />
            {kindLabels[kind]}
          </Button>
        );
      })}
      {capabilities === null && capabilitiesError !== null ? (
        <div role="alert" className="flex items-center gap-1 pl-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">
            <props.Tooltip label={capabilitiesError}>
              <span className="min-w-0 truncate">Step types unavailable</span>
            </props.Tooltip>
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            ariaLabel="Retry loading step types"
            tooltip="Retry"
            onClick={onRetryCapabilities}
          >
            <RefreshCwIcon />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
