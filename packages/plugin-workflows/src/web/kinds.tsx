import {
  BotIcon,
  CircleDashedIcon,
  Columns3Icon,
  FlagIcon,
  MergeIcon,
  ScanEyeIcon,
  SplitIcon,
  TerminalIcon,
  UserCheckIcon,
  type LucideIcon,
} from "lucide-react";
import type { FlowNode } from "./flowGraph.ts";

export const kindIcons: Record<FlowNode["kind"], LucideIcon> = {
  agent: BotIcon,
  check: TerminalIcon,
  decision: SplitIcon,
  parallel: Columns3Icon,
  join: MergeIcon,
  human: UserCheckIcon,
  end: FlagIcon,
  branch: ScanEyeIcon,
  missing: CircleDashedIcon,
};

export function KindIcon({
  kind,
  className,
}: {
  readonly kind: FlowNode["kind"];
  readonly className?: string;
}) {
  const Icon = kindIcons[kind];
  return <Icon aria-hidden className={className} />;
}
