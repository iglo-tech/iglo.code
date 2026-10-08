import type { ComponentType, ReactNode } from "react";
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

/** Host-owned controls; plugins choose a variant instead of restyling them. */
export interface PluginDesign {
  readonly Button: ComponentType<{
    readonly children: ReactNode;
    readonly id?: string;
    readonly ariaLabel?: string;
    readonly ariaPressed?: boolean;
    readonly disabled?: boolean;
    readonly onClick: () => void;
    readonly variant?: "default" | "outline" | "ghost" | "destructive";
    readonly size?: "sm" | "default";
  }>;
  readonly Input: ComponentType<
    ControlProps & {
      readonly value: string;
      readonly onChange: (value: string) => void;
      readonly type?: "text" | "number" | "search";
      readonly placeholder?: string;
      readonly readOnly?: boolean;
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
  /** Labeled panel for narrow layouts; plugins render the same content inline when wide. */
  readonly Sheet: ComponentType<{
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly title: string;
    readonly side?: "left" | "right" | "bottom";
    readonly children: ReactNode;
  }>;
  /** Holds in-app navigation while `when` is true and offers Keep editing or Discard. */
  readonly NavigationGuard: ComponentType<{
    readonly when: boolean;
    readonly title: string;
    readonly description: string;
    readonly onDiscard?: () => void;
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
    readonly link: PluginPageLink;
  }>;
  readonly projectActions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly link: (projectId: ProjectId) => PluginPageLink;
  }>;
  readonly threadContext: ReadonlyArray<{
    readonly id: string;
    readonly render: (context: PluginWebContext & { readonly client: Client }) => ReactNode;
  }>;
}
