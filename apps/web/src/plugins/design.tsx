import { useBlocker } from "@tanstack/react-router";
import type { PluginDesign } from "@t3tools/plugin-host-contract/web";
import { useEffect, useRef, type ComponentProps } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../components/ui/sheet";
import { Textarea } from "../components/ui/textarea";

function NavigationGuard({
  when,
  title,
  description,
  onDiscard,
  keepLabel,
  protectReload = false,
}: ComponentProps<PluginDesign["NavigationGuard"]>) {
  const blocker = useBlocker({
    shouldBlockFn: () => when,
    withResolver: true,
    // Stored drafts survive a reload; plugins opt in when their edits would not.
    enableBeforeUnload: () => when && protectReload,
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
        {keepLabel === undefined ? null : (
          <Button variant="outline" size="sm" onClick={() => blocker.proceed?.()}>
            {keepLabel}
          </Button>
        )}
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
  Select: ({ id, ariaLabel, ariaDescribedBy, invalid, disabled, value, onChange, options }) => (
    <Select
      value={value}
      items={options.map((option) => ({ value: option.value, label: option.label }))}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
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
