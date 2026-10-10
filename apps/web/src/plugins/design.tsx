import { useBlocker } from "@tanstack/react-router";
import type { PluginBreadcrumbItem, PluginDesign } from "@t3tools/plugin-host-contract/web";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EllipsisIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { SettingsGroup } from "../components/settings/SettingsGroup";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../components/ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../components/ui/sheet";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
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

const crumbButtonClass =
  "inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-64";

function Crumb({ item, current }: { item: PluginBreadcrumbItem; current: boolean }) {
  const text = (
    <WorkspaceBreadcrumbText className={current ? "max-w-60" : "max-w-28 sm:max-w-60"}>
      {item.label}
    </WorkspaceBreadcrumbText>
  );
  if (item.options !== undefined && item.onChange !== undefined) {
    const onChange = item.onChange;
    return (
      <Menu>
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
        </MenuTrigger>
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
    return (
      <button
        type="button"
        aria-label={item.ariaLabel}
        disabled={item.disabled}
        onClick={item.onSelect}
        className={crumbButtonClass}
      >
        {text}
      </button>
    );
  return <h1 className="min-w-0 text-sm font-medium">{text}</h1>;
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
                  // The current page keeps its width first; parents truncate before it does.
                  className={current ? "min-w-10 shrink" : `min-w-6 shrink-[8] ${leading}`}
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

function PluginCombobox({
  id,
  ariaLabel,
  ariaDescribedBy,
  invalid,
  disabled,
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder = "Search…",
  emptyText = "No matches",
  query: controlledQuery,
  onQueryChange,
}: ComponentProps<PluginDesign["Combobox"]>) {
  const [open, setOpen] = useState(false);
  const [localQuery, setLocalQuery] = useState("");
  const query = controlledQuery ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;
  const needle = query.trim().toLowerCase();
  // A plugin-owned search already narrowed `options`; otherwise match labels here.
  const shown =
    onQueryChange !== undefined || needle === ""
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(needle));
  const values = shown.map((option) => option.value);
  const selected = options.find((option) => option.value === value)?.label;
  return (
    <Combobox
      items={values}
      filteredItems={values}
      autoHighlight
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
      value={value === "" ? null : value}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        setOpen(false);
        onChange(next);
      }}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <ComboboxTrigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        render={<SelectButton />}
      >
        {selected ?? <span className="text-muted-foreground">{placeholder ?? ""}</span>}
      </ComboboxTrigger>
      <ComboboxPopup className="flex w-(--anchor-width) min-w-72 flex-col">
        <ComboboxSearchInput
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {shown.map((option, index) => (
            <ComboboxItem
              key={option.value}
              index={index}
              value={option.value}
              {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.detail === undefined ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">{option.detail}</span>
              )}
              <CheckIcon className={option.value === value ? "size-3.5" : "size-3.5 opacity-0"} />
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function PluginDialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: ComponentProps<PluginDesign["Dialog"]>) {
  // Without a document (server or test rendering) there is no portal layer; the dialog's
  // content renders in place so it keeps its accessible name and controls.
  if (typeof document === "undefined")
    return open ? (
      <div role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {description === undefined ? null : <p>{description}</p>}
        {children}
        {footer}
      </div>
    ) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
        {footer === undefined || footer === null ? null : <DialogFooter>{footer}</DialogFooter>}
      </DialogPopup>
    </Dialog>
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
  Select: ({
    id,
    ariaLabel,
    ariaDescribedBy,
    invalid,
    disabled,
    value,
    onChange,
    options,
    size,
  }) => (
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
        size={size ?? "default"}
        // Dense rows share their width, so a small trigger may shrink below the default minimum.
        shrink={size === "sm"}
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
            {option.detail === undefined ? (
              option.label
            ) : (
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate">{option.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{option.detail}</span>
              </span>
            )}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  ),
  Combobox: PluginCombobox,
  Badge: ({ variant = "outline", children }) => <Badge variant={variant}>{children}</Badge>,
  Tooltip: ({ content, children }) =>
    // Without a window (server or test rendering) only the trigger content renders.
    typeof window === "undefined" ? (
      <span className="min-w-0 truncate">{children}</span>
    ) : (
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate" />}>{children}</TooltipTrigger>
        <TooltipPopup side="bottom">{content}</TooltipPopup>
      </Tooltip>
    ),
  toast: ({ title, description, variant = "success" }) => {
    toastManager.add({
      type: variant,
      title,
      ...(description === undefined ? {} : { description }),
    });
  },
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
  SegmentedControl: ({ ariaLabel, value, onChange, options, disabled }) => (
    <ToggleGroup
      aria-label={ariaLabel}
      variant="segmented"
      {...(disabled === undefined ? {} : { disabled })}
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
          <span className="mt-0.5 block truncate text-xs text-muted-foreground/80">
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
  Dialog: PluginDialog,
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
