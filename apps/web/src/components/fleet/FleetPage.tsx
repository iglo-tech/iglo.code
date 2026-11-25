import type { HostHealthRange, HostHealthSnapshot } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { ServerIcon } from "lucide-react";

import { isElectron } from "~/env";
import { useEnvironments } from "../../state/environments";
import { cn } from "../../lib/utils";
import { SidebarInset } from "../ui/sidebar";
import { Badge } from "../ui/badge";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { FleetHost } from "./fleetHosts";
import { HostHealthDetail } from "./HostHealthDetail";
import {
  formatRate,
  formatUptime,
  HOST_HEALTH_RANGES,
  hostHealthStatus,
  hottestSensor,
  usedPercent,
} from "./hostHealthFormat";
import { HostUsageBar } from "./HostUsageBar";
import { useFleetHosts, useHostHealthSnapshot } from "./useHostHealth";

export interface FleetSearch {
  readonly host?: string;
  readonly range?: HostHealthRange;
}

export function FleetPage() {
  const search = useSearch({ from: "/_chat/fleet" });
  const navigate = useNavigate();
  const gt = useGT();
  const hosts = useFleetHosts();
  const { isReady } = useEnvironments();
  const range = search.range ?? "1h";
  const selected =
    search.host === undefined
      ? null
      : (hosts.find((host) => host.environmentId === search.host) ?? null);
  const go = (next: FleetSearch) => void navigate({ to: "/fleet", search: next });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel={gt("Fleet breadcrumb")} className="flex-1">
            <WorkspaceBreadcrumbItem current={search.host === undefined}>
              {search.host === undefined ? (
                <h1 className="truncate">
                  <T>Fleet</T>
                </h1>
              ) : (
                <button
                  type="button"
                  onClick={() => go({})}
                  className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <WorkspaceBreadcrumbText>
                    <T>Fleet</T>
                  </WorkspaceBreadcrumbText>
                </button>
              )}
            </WorkspaceBreadcrumbItem>
            {search.host === undefined ? null : (
              <>
                <WorkspaceBreadcrumbSeparator>
                  <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
                  <h1 className="min-w-0">
                    <WorkspaceBreadcrumbText>
                      {selected?.label ?? search.host}
                    </WorkspaceBreadcrumbText>
                  </h1>
                </WorkspaceBreadcrumbItem>
              </>
            )}
          </WorkspaceBreadcrumb>
          {selected === null ? null : (
            <ToggleGroup
              variant="segmented"
              value={[range]}
              onValueChange={(next) => {
                const picked = HOST_HEALTH_RANGES.find((option) => option === next[0]);
                if (picked !== undefined) {
                  void navigate({
                    to: "/fleet",
                    search: { host: selected.environmentId, range: picked },
                    replace: true,
                  });
                }
              }}
            >
              {HOST_HEALTH_RANGES.map((option) => (
                <Toggle key={option} value={option}>
                  {option}
                </Toggle>
              ))}
            </ToggleGroup>
          )}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {search.host === undefined ? (
            <FleetOverview hosts={hosts} onOpen={(host) => go({ host: host.environmentId })} />
          ) : selected !== null ? (
            <HostHealthDetail host={selected} range={range} />
          ) : isReady ? (
            <p className="p-6 text-sm text-muted-foreground">
              <T>This machine is not connected or linked here anymore.</T>
            </p>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function FleetOverview({
  hosts,
  onOpen,
}: {
  readonly hosts: ReadonlyArray<FleetHost>;
  readonly onOpen: (host: FleetHost) => void;
}) {
  if (hosts.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        <T>Connect or link another machine to see it here.</T>
      </p>
    );
  }
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
      {hosts.map((host) => (
        <FleetHostCard key={host.environmentId} host={host} onOpen={() => onOpen(host)} />
      ))}
    </div>
  );
}

const STATUS_DOT = {
  ok: "bg-success",
  warning: "bg-warning",
  critical: "bg-destructive",
  unknown: "bg-muted-foreground/40",
} as const;

function FleetHostCard({
  host,
  onOpen,
}: {
  readonly host: FleetHost;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const health = useHostHealthSnapshot(host);
  const snapshot = health.data;
  const status = snapshot === null ? "unknown" : hostHealthStatus(snapshot);
  const live = host.availability === "live";

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!live}
      className="flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg border border-border/60 bg-card p-4 text-left transition-colors hover:border-border hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-70 disabled:hover:border-border/60 disabled:hover:bg-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])}
          aria-label={
            status === "critical"
              ? gt("Critical", { $context: "host health status" })
              : status === "warning"
                ? gt("Warning", { $context: "host health status" })
                : status === "ok"
                  ? gt("Healthy", { $context: "host health status" })
                  : gt("Unknown", { $context: "host health status" })
          }
        />
        <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{host.label}</span>
        {snapshot !== null && snapshot.alerts.length > 0 ? (
          <Badge
            size="sm"
            variant={status === "critical" ? "error" : "warning"}
            className="ml-auto"
          >
            {snapshot.alerts.length}
          </Badge>
        ) : null}
      </div>
      {host.viaLabel === null ? null : (
        <p className="-mt-2 truncate text-2xs text-muted-foreground">
          {gt("Linked through {environment}", { environment: host.viaLabel })}
        </p>
      )}
      {!live ? (
        <p className="text-xs text-muted-foreground">
          {host.availability === "offline" ? (
            <T>Not connected.</T>
          ) : host.availability === "unsupported" ? (
            <T>Update this server to see its health.</T>
          ) : (
            <T>This connection cannot read its diagnostics.</T>
          )}
        </p>
      ) : snapshot === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {health.error ?? <T>Reading health…</T>}
        </p>
      ) : (
        <FleetHostSummary snapshot={snapshot} />
      )}
    </button>
  );
}

function FleetHostSummary({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const gt = useGT();
  const resolve = useMessages();
  const root = snapshot.disks[0] ?? null;
  const hottest = hottestSensor(snapshot.sensors);
  return (
    <div className="flex flex-col gap-2">
      <HostUsageBar label={gt("CPU")} percent={snapshot.cpu.utilizationPercent} />
      <HostUsageBar
        label={gt("Memory")}
        percent={usedPercent(snapshot.memory.usedBytes, snapshot.memory.totalBytes)}
      />
      {root === null ? null : (
        <HostUsageBar
          label={gt("Disk {mount}", { mount: root.mountPoint })}
          percent={root.usedPercent}
        />
      )}
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <dt>
          <T context="system load average">Load</T>
        </dt>
        <dd className="text-right tabular-nums text-foreground">
          {snapshot.cpu.load1m.toFixed(2)}
        </dd>
        <dt>
          <T>Network</T>
        </dt>
        <dd className="truncate text-right tabular-nums text-foreground">
          ↓ {formatRate(snapshot.network.rxBytesPerSec)} ↑{" "}
          {formatRate(snapshot.network.txBytesPerSec)}
        </dd>
        {hottest === null ? null : (
          <>
            <dt>
              <T>Hottest sensor</T>
            </dt>
            <dd className="truncate text-right tabular-nums text-foreground">
              {hottest.value.toFixed(0)} °C
            </dd>
          </>
        )}
        <dt>
          <T>Uptime</T>
        </dt>
        <dd className="text-right tabular-nums text-foreground">
          {formatUptime(snapshot.metadata.uptimeSeconds, resolve)}
        </dd>
      </dl>
    </div>
  );
}
