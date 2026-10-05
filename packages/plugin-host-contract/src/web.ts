import type { ComponentType, ReactNode } from "react";
import type {
  EnvironmentId,
  PluginDescriptor,
  PluginManifest,
  PluginPageLink,
  PluginTarget,
  ProjectId,
} from "./schema.ts";

export interface PluginWebContext {
  readonly environmentId: EnvironmentId;
  readonly descriptor: PluginDescriptor;
  readonly projectId: ProjectId | null;
  readonly threadId: PluginTarget["threadId"] | null;
  readonly navigate: (link: PluginPageLink) => void;
  readonly openThread: (target: PluginTarget) => void;
  readonly Button: ComponentType<{
    readonly children: ReactNode;
    readonly disabled?: boolean;
    readonly onClick: () => void;
    readonly variant?: "default" | "outline" | "ghost";
    readonly size?: "sm" | "default";
  }>;
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
