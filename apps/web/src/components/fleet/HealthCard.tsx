import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { HealthTone } from "./healthTones";

function Root({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-xl border border-border/60 bg-card p-4",
        className,
      )}
      {...props}
    />
  );
}

function Header({
  tone,
  icon: Icon,
  title,
  aside,
}: {
  readonly tone: HealthTone;
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly aside?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 items-center gap-2.5">
      <span className={cn("grid size-6 shrink-0 place-items-center rounded-md", tone.tile)}>
        <Icon className="size-3.5" />
      </span>
      <h2 className={cn("shrink-0 text-sm font-semibold", tone.title)}>{title}</h2>
      {aside === undefined ? null : (
        <div className="ml-auto min-w-0 truncate text-right text-2xs text-muted-foreground">
          {aside}
        </div>
      )}
    </header>
  );
}

/** A value with its unit set smaller, as "11.7 GB" or "27%". */
function splitUnit(text: string): readonly [string, string] {
  if (text.endsWith("%")) return [text.slice(0, -1), "%"];
  const space = text.lastIndexOf(" ");
  return space < 0 ? [text, ""] : [text.slice(0, space), text.slice(space + 1)];
}

function Hero({
  label,
  value,
  size = "lg",
  className,
}: {
  readonly label: ReactNode;
  readonly value: string;
  readonly size?: "lg" | "md";
  readonly className?: string;
}) {
  const [number, unit] = splitUnit(value);
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="truncate text-2xs text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-baseline gap-0.5 font-semibold tabular-nums tracking-tight text-foreground">
        <span className={size === "lg" ? "text-4xl leading-none" : "text-2xl leading-none"}>
          {number}
        </span>
        {unit === "" ? null : (
          <span className={cn("text-muted-foreground", size === "lg" ? "text-sm" : "text-xs")}>
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

function Stats({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <dl className={cn("grid grid-cols-3 gap-x-3 gap-y-2", className)}>{children}</dl>;
}

function Stat({ label, value }: { readonly label: ReactNode; readonly value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/** A labelled bar in the card's color that turns warm as it fills. */
function Meter({
  label,
  percent,
  value,
  fillClassName,
  trackClassName,
}: {
  readonly label: ReactNode;
  readonly percent: number | null;
  readonly value: ReactNode;
  readonly fillClassName: string;
  readonly trackClassName: string;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(3rem,7rem)_auto] items-center gap-3 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className={cn("h-1.5 overflow-hidden rounded-full", trackClassName)}>
        <span
          className={cn("block h-full rounded-full", fillClassName)}
          style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
        />
      </span>
      <span className="text-right font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export const HealthCard = { Root, Header, Hero, Stats, Stat, Meter };
