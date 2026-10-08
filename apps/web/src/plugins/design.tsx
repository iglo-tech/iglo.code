import { useBlocker } from "@tanstack/react-router";
import type { PluginDesign } from "@t3tools/plugin-host-contract/web";
import { useEffect, useRef, type ComponentProps } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../components/ui/sheet";
import { Textarea } from "../components/ui/textarea";

function NavigationGuard({
  when,
  title,
  description,
  onDiscard,
}: ComponentProps<PluginDesign["NavigationGuard"]>) {
  const blocker = useBlocker({
    shouldBlockFn: () => when,
    withResolver: true,
    // Plugin drafts persist locally, so a reload loses nothing and needs no browser prompt.
    enableBeforeUnload: false,
  });
  const keep = useRef<HTMLButtonElement>(null);
  const blocked = blocker.status === "blocked";
  useEffect(() => {
    if (blocked) keep.current?.focus();
  }, [blocked]);
  if (!blocked) return null;
  return (
    <Alert variant="warning" role="alertdialog" aria-label={title}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      <AlertAction>
        <Button ref={keep} variant="outline" size="sm" onClick={() => blocker.reset?.()}>
          Keep editing
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            onDiscard?.();
            blocker.proceed?.();
          }}
        >
          Discard
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** Host-owned looks behind the small public design interface plugins receive. */
export const pluginDesign: PluginDesign = {
  Button: ({ ariaLabel, ariaPressed, ...props }) => (
    <Button aria-label={ariaLabel} aria-pressed={ariaPressed} {...props} />
  ),
  Input: ({ ariaLabel, ariaDescribedBy, invalid, onChange, ...props }) => (
    <Input
      {...props}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || undefined}
      nativeInput
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
  Textarea: ({ ariaLabel, ariaDescribedBy, invalid, onChange, ...props }) => (
    <Textarea
      {...props}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
  Select: ({ ariaLabel, ariaDescribedBy, invalid, onChange, options, ...props }) => (
    <select
      {...props}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 disabled:opacity-64 aria-invalid:border-destructive/36 sm:h-8 sm:text-sm dark:bg-input/32"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Badge: ({ variant = "outline", children }) => <Badge variant={variant}>{children}</Badge>,
  Sheet: ({ open, onOpenChange, title, side = "right", children }) => (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side={side}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
      </SheetPopup>
    </Sheet>
  ),
  NavigationGuard,
};
