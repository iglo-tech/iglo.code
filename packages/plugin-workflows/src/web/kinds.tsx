import {
  BotIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  FileCheckIcon,
  UserRoundIcon,
  Columns3Icon,
  FlagIcon,
  MergeIcon,
  ScanEyeIcon,
  SplitIcon,
  TerminalIcon,
  UserCheckIcon,
  type LucideIcon,
} from "lucide-react";
import type { Run } from "../contracts.ts";
import type { FlowNode } from "./flowGraph.ts";
import type { StepStatus } from "./run.ts";

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

// Static icons only: run state never animates.
export const statusIcons: Record<StepStatus, LucideIcon> = {
  pending: CircleDashedIcon,
  running: CircleDotIcon,
  reported: FileCheckIcon,
  completed: CircleCheckIcon,
  failed: CircleXIcon,
  stopped: CircleSlashIcon,
};
export const statusTone: Record<StepStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-info",
  reported: "text-info",
  completed: "text-success",
  failed: "text-destructive",
  stopped: "text-warning",
};

export function StatusIcon({
  status,
  className = "size-4",
}: {
  readonly status: StepStatus;
  readonly className?: string;
}) {
  const Icon = statusIcons[status];
  return <Icon aria-hidden className={`shrink-0 ${statusTone[status]} ${className}`} />;
}

const runIcons: Record<Run["state"], LucideIcon> = {
  running: CircleDotIcon,
  "awaiting-review": UserRoundIcon,
  unresolved: CircleSlashIcon,
  completed: CircleCheckIcon,
  failed: CircleXIcon,
  canceled: CircleSlashIcon,
};
const runTone: Record<Run["state"], string> = {
  running: "text-info",
  "awaiting-review": "text-warning",
  unresolved: "text-warning",
  completed: "text-success",
  failed: "text-destructive",
  canceled: "text-muted-foreground",
};

export function RunStateIcon({
  state,
  className = "size-4",
}: {
  readonly state: Run["state"];
  readonly className?: string;
}) {
  const Icon = runIcons[state];
  return <Icon aria-hidden className={`shrink-0 ${runTone[state]} ${className}`} />;
}
