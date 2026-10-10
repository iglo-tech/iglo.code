import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import type {
  EnvironmentId,
  PluginDescriptor,
  PluginManifest,
  PluginPageLink,
  PluginPageState,
  PluginTarget,
  ProjectId,
} from "./schema.ts";

/** Bounded editing state scoped to one environment and plugin; never execution state. */
export interface PluginDraftStore {
  readonly read: (key: string) => string | null;
  /** Stored keys, least recently written first. */
  readonly keys: () => ReadonlyArray<string>;
  /** Returns false when the value exceeds the host bound or storage is unavailable. */
  readonly write: (key: string, value: string) => boolean;
  readonly remove: (key: string) => void;
}

interface ControlProps {
  readonly id?: string;
  readonly ariaLabel?: string;
  readonly ariaDescribedBy?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
}

/**
 * Icons the host renders for plugin navigation and actions. Names follow lucide; the host owns
 * the set so plugin entries look like the app's own and ship no icon code in the shell bundle.
 */
export type PluginIconName =
  | "workflow"
  | "list-checks"
  | "git-branch"
  | "file-text"
  | "bell"
  | "inbox"
  | "calendar-clock"
  | "play"
  | "bot"
  | "layout-grid"
  | "puzzle";

/** One action in a host menu. */
export interface PluginMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}

/** One header breadcrumb segment; the last one is the current page. */
export interface PluginBreadcrumbItem {
  readonly label: string;
  /** Makes the segment a link back to its page. */
  readonly onSelect?: () => void;
  /** Makes the segment a switcher, like the project segment of a page with a project. */
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly value?: string;
  readonly onChange?: (value: string) => void;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
}

/** Host-owned controls; plugins choose a variant instead of restyling them. */
export interface PluginDesign {
  readonly Button: ComponentType<{
    readonly children: ReactNode;
    readonly id?: string;
    readonly ariaLabel?: string;
    readonly ariaPressed?: boolean;
    readonly ariaKeyShortcuts?: string;
    readonly disabled?: boolean;
    readonly onClick: () => void;
    readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
    /** Shown on hover and focus; icon-only buttons should always have one. */
    readonly tooltip?: string;
    readonly variant?: "default" | "outline" | "ghost" | "destructive";
    /** `row` is a full-width, start-aligned list row, as in a palette or menu list. */
    readonly size?: "sm" | "default" | "xs" | "icon-sm" | "icon-xs" | "row";
  }>;
  readonly Input: ComponentType<
    ControlProps & {
      readonly value: string;
      readonly onChange: (value: string) => void;
      readonly type?: "text" | "number" | "search";
      readonly placeholder?: string;
      readonly readOnly?: boolean;
      readonly autoFocus?: boolean;
      readonly size?: "sm" | "default";
    }
  >;
  readonly Textarea: ComponentType<
    ControlProps & {
      readonly value: string;
      readonly onChange: (value: string) => void;
      readonly rows?: number;
      readonly placeholder?: string;
      readonly readOnly?: boolean;
    }
  >;
  /** A native select: keyboard, touch and screen-reader behavior without a popup layer. */
  readonly Select: ComponentType<
    ControlProps & {
      readonly value: string;
      readonly onChange: (value: string) => void;
      readonly options: ReadonlyArray<{
        readonly value: string;
        readonly label: string;
        readonly disabled?: boolean;
      }>;
    }
  >;
  readonly Badge: ComponentType<{
    readonly children: ReactNode;
    readonly variant?: "outline" | "secondary" | "info" | "success" | "warning" | "error";
  }>;
  /** A host-owned icon, for icon buttons in host slots such as the chat header. */
  readonly Icon: ComponentType<{ readonly name: PluginIconName }>;
  /** An overflow (`…`) menu, or a menu behind custom trigger content. */
  readonly Menu: ComponentType<{
    readonly ariaLabel: string;
    readonly items: ReadonlyArray<PluginMenuItem>;
    readonly trigger?: ReactNode;
    readonly disabled?: boolean;
  }>;
  /** A small segmented switch between views of the same content. */
  readonly SegmentedControl: ComponentType<{
    readonly ariaLabel: string;
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  }>;
  /** A status or failure notice with optional actions; `children` is the short detail. */
  readonly Alert: ComponentType<{
    readonly variant: "info" | "warning" | "error";
    readonly title: string;
    readonly children?: ReactNode;
    readonly actions?: ReactNode;
  }>;
  /** The app's empty state: a title, an optional one-line description and actions. */
  readonly Empty: ComponentType<{
    readonly title: string;
    readonly description?: string;
    readonly icon?: ReactNode;
    readonly children?: ReactNode;
  }>;
  /** A titled group of rows on the app's card surface, as on Settings pages. */
  readonly ListGroup: ComponentType<{
    readonly title?: string;
    readonly action?: ReactNode;
    readonly ariaLabel?: string;
    readonly busy?: boolean;
    /** False for a group holding a form or other content instead of rows. */
    readonly list?: boolean;
    readonly children: ReactNode;
  }>;
  /**
   * One row of a list group: a title with badges, a muted one-line description, and trailing
   * actions. `onOpen` makes the row's title area the primary action.
   */
  readonly ListRow: ComponentType<{
    readonly title: string;
    readonly badges?: ReactNode;
    readonly description?: ReactNode;
    readonly leading?: ReactNode;
    readonly onOpen?: () => void;
    readonly openLabel?: string;
    readonly actions?: ReactNode;
    readonly children?: ReactNode;
  }>;
  /**
   * The page's own header bar: a breadcrumb and trailing actions. A page that renders it
   * replaces the host's title bar and manages its own scrolling below it.
   */
  readonly PageHeader: ComponentType<{
    readonly breadcrumb: ReadonlyArray<PluginBreadcrumbItem>;
    readonly children?: ReactNode;
  }>;
  /** Labeled panel for narrow layouts; plugins render the same content inline when wide. */
  readonly Sheet: ComponentType<{
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly title: string;
    readonly side?: "left" | "right" | "bottom";
    readonly children: ReactNode;
  }>;
  /**
   * Holds in-app navigation while `when` is true and offers Keep editing or Discard, plus
   * `keepLabel` to leave while keeping a stored draft. `protectReload` also asks before a
   * reload or tab close, for edits that would not survive one.
   */
  readonly NavigationGuard: ComponentType<{
    readonly when: boolean;
    readonly title: string;
    readonly description: string;
    readonly onDiscard?: () => void;
    readonly keepLabel?: string;
    readonly protectReload?: boolean;
  }>;
}

export interface PluginWebContext extends PluginDesign {
  readonly environmentId: EnvironmentId;
  /** Human label of the bound environment, shown so users know where work runs. */
  readonly environmentLabel: string;
  readonly descriptor: PluginDescriptor;
  readonly projectId: ProjectId | null;
  readonly threadId: PluginTarget["threadId"] | null;
  /** Validated, bounded selection from the current link. */
  readonly pageState: PluginPageState;
  /** Disconnected pages keep their last snapshot; mutations wait until reconnection. */
  readonly connection: "connected" | "disconnected";
  readonly navigate: (link: PluginPageLink, options?: { readonly replace?: boolean }) => void;
  readonly openThread: (target: PluginTarget) => void;
  readonly drafts: PluginDraftStore;
}

/** The host supplies an authenticated, environment-bound typed client to each contribution. */
export interface WebPlugin<Client> {
  readonly manifest: PluginManifest;
  readonly pages: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly component: ComponentType<PluginWebContext & { readonly client: Client }>;
  }>;
  readonly navigation: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly icon: PluginIconName;
    readonly link: PluginPageLink;
  }>;
  readonly projectActions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly icon: PluginIconName;
    readonly link: (projectId: ProjectId) => PluginPageLink;
  }>;
  readonly threadContext: ReadonlyArray<{
    readonly id: string;
    readonly render: (context: PluginWebContext & { readonly client: Client }) => ReactNode;
  }>;
}
