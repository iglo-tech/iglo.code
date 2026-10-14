import type { PluginIconName } from "@t3tools/plugin-host-contract/web";
import {
  BellIcon,
  BotIcon,
  CalendarClockIcon,
  FileTextIcon,
  GitBranchIcon,
  InboxIcon,
  LayoutGridIcon,
  ListChecksIcon,
  PlayIcon,
  PuzzleIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";

const icons: Record<PluginIconName, LucideIcon> = {
  workflow: WorkflowIcon,
  "list-checks": ListChecksIcon,
  "git-branch": GitBranchIcon,
  "file-text": FileTextIcon,
  bell: BellIcon,
  inbox: InboxIcon,
  "calendar-clock": CalendarClockIcon,
  play: PlayIcon,
  bot: BotIcon,
  "layout-grid": LayoutGridIcon,
  puzzle: PuzzleIcon,
};

/** The host-owned icon for a plugin entry; unknown names (an older client) fall back. */
export function PluginIcon({ name }: { readonly name: PluginIconName }) {
  const Icon = icons[name] ?? PuzzleIcon;
  return <Icon />;
}
