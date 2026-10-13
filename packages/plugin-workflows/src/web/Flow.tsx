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
/** Add a step: kinds this client authors are enabled; the rest stay visible but unavailable. */
export function Palette({
  props,
  capabilities,
  disabled,
  onAdd,
}: {
  readonly props: PageProps;
  readonly capabilities: Capabilities | null;
  readonly disabled: boolean;
  readonly onAdd: (kind: EditableKind) => void;
}) {
  const { Button } = props;
  const advertised = capabilities?.nodeKinds;
  return (
    <nav aria-label="Add a step" className="flex flex-col gap-0.5">
      {(Object.keys(kindLabels) as Array<Node["kind"]>).map((kind) => {
        const supported = advertised === undefined || advertised.includes(kind);
        const authored = (editableKinds as ReadonlyArray<string>).includes(kind);
        return (
          <Button
            key={kind}
            variant="ghost"
            size="row"
            disabled={disabled || !supported || !authored}
            onClick={() => onAdd(kind as EditableKind)}
          >
            <KindIcon kind={kind} />
            {kindLabels[kind]}
          </Button>
        );
      })}
    </nav>
  );
}
