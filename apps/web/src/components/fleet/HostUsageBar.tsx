import { cn } from "../../lib/utils";
import { formatPercent } from "./hostHealthFormat";

export function HostUsageBar({
  label,
  percent,
  detail,
}: {
  readonly label: string;
  readonly percent: number | null;
  readonly detail?: string;
}) {
  const tone =
    percent === null
      ? "bg-muted-foreground/30"
      : percent >= 90
        ? "bg-destructive"
        : percent >= 75
          ? "bg-warning"
          : "bg-foreground/60";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-2xs">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 tabular-nums text-foreground">
          {detail === undefined ? formatPercent(percent) : `${formatPercent(percent)} · ${detail}`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", tone)}
          style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
        />
      </div>
    </div>
  );
}
