import { useBlocker } from "@tanstack/react-router";
import type { PluginBreadcrumbItem, PluginDesign } from "@t3tools/plugin-host-contract/web";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EllipsisIcon,
  InfoIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Fragment, useLayoutEffect, useRef, type ComponentProps, type ReactElement } from "react";
import { SettingsGroup } from "../components/settings/SettingsGroup";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../components/ui/sheet";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { PluginIcon } from "./pluginIcons";
import { pageStatusNotice, usePluginPageChrome, type PluginPageChrome } from "./pageChrome";

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
  const blocked = blocker.status === "blocked";
  const actions = (
    <>
      <Button variant="outline" size="sm" autoFocus onClick={() => blocker.reset?.()}>
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
    </>
  );
  return (
    <AlertDialog
      open={blocked}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description === undefined ? null : (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>{actions}</AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * A plugin panel's content decides what it holds, so it opens with focus on the panel itself:
 * Enter on arrival never lands on a destructive control that happens to come first.
 */
const PluginSheet: PluginDesign["Sheet"] = ({
  open,
  onOpenChange,
  title,
  side = "right",
  children,
}) => {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        ref={popup}
        initialFocus={popup}
        // A sheet that hands over to another one (add a step, then its inspector) must not pull
        // focus back to its opener once the next sheet has taken it.
        finalFocus={() => document.querySelector('[data-slot="sheet-popup"][data-open]') === null}
        side={side}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
      </SheetPopup>
    </Sheet>
  );
};

function PluginDialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
}: ComponentProps<PluginDesign["Dialog"]>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
        {footer === undefined ? null : <DialogFooter>{footer}</DialogFooter>}
      </DialogPopup>
    </Dialog>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ComponentProps<PluginDesign["ConfirmDialog"]>) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description === undefined ? null : (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" size="sm" autoFocus onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

// No `max-w-full`: with the negative margins it clamps the button to its own li's intrinsic
// width, which is narrower than the button, so the label truncated with room to spare.
const crumbButtonClass =
  "-mx-1.5 -my-0.5 inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-64";

function Crumb({ item, current }: { item: PluginBreadcrumbItem; current: boolean }) {
  const text = (
    <WorkspaceBreadcrumbText className={current ? undefined : "max-w-28 sm:max-w-60"}>
      {item.label}
    </WorkspaceBreadcrumbText>
  );
  // A crumb can truncate, so it carries its full label as a tooltip. Tooltips need a window.
  const withTooltip = (trigger: ReactElement) =>
    typeof window === "undefined" ? (
      trigger
    ) : (
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipPopup side="bottom">{item.label}</TooltipPopup>
      </Tooltip>
    );
  if (item.options !== undefined && item.onChange !== undefined) {
    const onChange = item.onChange;
    return (
      <Menu>
        {withTooltip(
          <MenuTrigger
            disabled={item.disabled}
            aria-label={item.ariaLabel ?? item.label}
            render={
              <button
                type="button"
                className={current ? `${crumbButtonClass} text-foreground` : crumbButtonClass}
              />
            }
          >
            {text}
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-64" />
          </MenuTrigger>,
        )}
        <MenuPopup align="start">
          {item.options.map((option) => (
            <MenuItem key={option.value} onClick={() => onChange(option.value)}>
              <CheckIcon className={option.value === item.value ? undefined : "opacity-0"} />
              {option.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    );
  }
  if (item.onSelect !== undefined && !current)
    return withTooltip(
      <button
        type="button"
        aria-label={item.ariaLabel}
        disabled={item.disabled}
        onClick={item.onSelect}
        className={crumbButtonClass}
      >
        {text}
      </button>,
    );
  return withTooltip(<h1 className="min-w-0 text-sm font-medium">{text}</h1>);
}

/** The connection notice a page shows while its environment is not reconciled. */
export function PluginPageStatusStrip({ chrome }: { chrome: PluginPageChrome }) {
  if (chrome.status === "connected") return null;
  const notice = pageStatusNotice[chrome.status];
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-warning/8 px-(--workspace-gutter-start) py-1.5 text-xs"
    >
      <TriangleAlertIcon aria-hidden className="size-3.5 text-warning" />
      <span className="font-medium">{notice.title}</span>
      <span className="text-muted-foreground">{notice.detail}</span>
      {chrome.status === "catalog-unavailable" && chrome.onRetryCatalog !== undefined ? (
        <Button size="xs" variant="outline" onClick={chrome.onRetryCatalog}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function PageHeader({ breadcrumb, children }: ComponentProps<PluginDesign["PageHeader"]>) {
  const chrome = usePluginPageChrome();
  const claim = chrome?.claimHeader;
  useLayoutEffect(() => claim?.(), [claim]);
  const items =
    chrome?.showEnvironment === true
      ? [{ label: chrome.environmentLabel }, ...breadcrumb]
      : breadcrumb;
  return (
    <>
      <WorkspacePageHeader electron={chrome?.electron ?? false}>
        <WorkspaceBreadcrumb
          ariaLabel="Page breadcrumb"
          className="flex-1 overflow-clip [overflow-clip-margin:2px]"
        >
          {items.map((item, index) => {
            const current = index === items.length - 1;
            // Narrow screens keep the parent and current page (the way back and where you
            // are); earlier context such as environment or project folds away.
            const leading = index < items.length - 2 ? "max-sm:hidden" : "";
            return (
              <Fragment key={index}>
                <WorkspaceBreadcrumbItem
                  current={current}
                  // The current page takes the free space, like the chat header's thread title,
                  // so crumbs truncate only when the bar is out of room; parents give way first.
                  className={current ? "min-w-10 flex-1" : `min-w-6 shrink-[8] ${leading}`}
                >
                  <Crumb item={item} current={current} />
                </WorkspaceBreadcrumbItem>
                {current ? null : (
                  <WorkspaceBreadcrumbSeparator className={leading}>
                    <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                  </WorkspaceBreadcrumbSeparator>
                )}
              </Fragment>
            );
          })}
        </WorkspaceBreadcrumb>
        {children === undefined || children === null ? null : (
          <div className="[app-region:no-drag] flex shrink-0 items-center gap-1.5">{children}</div>
        )}
      </WorkspacePageHeader>
      {chrome === null ? null : <PluginPageStatusStrip chrome={chrome} />}
    </>
  );
}

const alertIcons = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon,
} as const;

/** Host-owned looks behind the small public design interface plugins receive. */
export const pluginDesign: PluginDesign = {
  Button: ({ ariaLabel, ariaPressed, ariaKeyShortcuts, tooltip, ...props }) => {
    const button = (
      <Button
        aria-label={ariaLabel}
        aria-pressed={ariaPressed}
        aria-keyshortcuts={ariaKeyShortcuts}
        {...props}
      />
    );
    // Tooltips attach window listeners; without a window (server or test rendering) the
    // accessible name still carries the label.
    if (tooltip === undefined || typeof window === "undefined") return button;
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
    );
  },
  Input: ({ ariaLabel, ariaDescribedBy, invalid, onChange, ...props }) => {
    const input = {
      ...props,
      "aria-label": ariaLabel,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": invalid || undefined,
      onChange: (event: { currentTarget: { value: string } }) =>
        onChange(event.currentTarget.value),
    };
    // Search fields carry the app's leading search icon.
    if (props.type === "search")
      return (
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput {...input} />
        </InputGroup>
      );
    return <Input {...input} nativeInput />;
  },
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
  Tooltip: ({ label, children, disabled }) => (
    <Tooltip disabled={disabled === true}>
      <TooltipTrigger render={children} />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  ),
  Icon: PluginIcon,
  Menu: ({ ariaLabel, items, trigger, disabled }) => (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size={trigger === undefined ? "icon-sm" : "sm"}
            aria-label={ariaLabel}
          />
        }
      >
        {trigger ?? <EllipsisIcon />}
      </MenuTrigger>
      <MenuPopup align="end">
        {items.map((item) => (
          <MenuItem
            key={item.label}
            disabled={item.disabled}
            variant={item.destructive ? "destructive" : "default"}
            onClick={item.onSelect}
          >
            {item.icon}
            {item.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  ),
  SegmentedControl: ({ ariaLabel, value, onChange, options }) => (
    <ToggleGroup
      aria-label={ariaLabel}
      variant="segmented"
      value={[value]}
      onValueChange={(next) => {
        const selected = next[0];
        if (typeof selected === "string") onChange(selected);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  ),
  Alert: ({ variant, title, children, actions }) => {
    const Icon = alertIcons[variant];
    return (
      <Alert variant={variant}>
        <Icon aria-hidden />
        <AlertTitle>{title}</AlertTitle>
        {children === undefined || children === null ? null : (
          <AlertDescription>{children}</AlertDescription>
        )}
        {actions === undefined || actions === null ? null : <AlertAction>{actions}</AlertAction>}
      </Alert>
    );
  },
  Empty: ({ title, description, icon, children }) => (
    <Empty size="compact">
      {icon === undefined ? null : <EmptyMedia variant="icon">{icon}</EmptyMedia>}
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description === undefined ? null : <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children === undefined || children === null ? null : (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">{children}</div>
        </EmptyContent>
      )}
    </Empty>
  ),
  ListGroup: ({ title, action, ariaLabel, busy, list = true, children }) => (
    <section aria-label={ariaLabel ?? title} className="flex flex-col gap-2.5">
      {title === undefined && action === undefined ? null : (
        <div className="flex min-h-7 items-center justify-between gap-4 px-3 sm:px-4">
          <h2 className="text-sm font-normal text-foreground/70">{title}</h2>
          {action}
        </div>
      )}
      <SettingsGroup role={list ? "list" : undefined} aria-busy={busy || undefined}>
        {children}
      </SettingsGroup>
    </section>
  ),
  ListRow: ({ title, badges, description, leading, onOpen, openLabel, actions, children }) => {
    const body = (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
          {badges}
        </span>
        {description === undefined || description === null ? null : (
          <span className="mt-0.5 line-clamp-2 text-xs break-words text-muted-foreground/80">
            {description}
          </span>
        )}
      </>
    );
    return (
      <div
        role="listitem"
        className={
          onOpen === undefined
            ? "flex flex-col gap-2 px-3 py-2.5 sm:px-4"
            : "flex flex-col gap-2 px-3 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/40 sm:px-4"
        }
      >
        <div className="flex min-w-0 items-center gap-3">
          {leading === undefined ? null : (
            <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{leading}</span>
          )}
          {onOpen === undefined ? (
            <div className="min-w-0 flex-1">{body}</div>
          ) : (
            <button
              type="button"
              aria-label={openLabel ?? title}
              onClick={onOpen}
              className="min-w-0 flex-1 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {body}
            </button>
          )}
          {actions === undefined || actions === null ? null : (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          )}
        </div>
        {children}
      </div>
    );
  },
  PageHeader,
  Sheet: PluginSheet,
  Dialog: PluginDialog,
  ConfirmDialog,
  NavigationGuard,
};
