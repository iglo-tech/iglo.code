import type { HostHealthRange, HostHealthSnapshot } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { ChevronRightIcon, ServerIcon } from "lucide-react";

import { isElectron } from "~/env";
import { useEnvironments } from "../../state/environments";
import { SidebarInset } from "../ui/sidebar";
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
import { formatBytes } from "../../lib/formatBytes";
import { DotMatrixChart } from "./DotMatrixChart";
import { HealthCard } from "./HealthCard";
import { HEALTH_TONES } from "./healthTones";
import {
  formatPercent,
  formatRate,
  formatUptime,
  HOST_HEALTH_RANGE_MS,
  HOST_HEALTH_RANGES,
  hottestSensor,
  usedPercent,
} from "./hostHealthFormat";
import { HostStatusBadge } from "./HostStatusBadge";
import { useFleetHosts, useHostHealthHistory, useHostHealthSnapshot } from "./useHostHealth";

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
    <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
      {hosts.map((host) => (
        <FleetHostCard key={host.environmentId} host={host} onOpen={() => onOpen(host)} />
      ))}
    </div>
  );
}

function FleetHostCard({
  host,
  onOpen,
}: {
  readonly host: FleetHost;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const health = useHostHealthSnapshot(host);
  const snapshot = health.data;
  const live = host.availability === "live";
  const subtitle =
    snapshot === null
      ? host.viaLabel === null
        ? null
        : gt("Linked through {environment}", { environment: host.viaLabel })
      : [
          snapshot.metadata.osVersion,
          gt("up {uptime}", { uptime: formatUptime(snapshot.metadata.uptimeSeconds, resolve) }),
          host.viaLabel === null
            ? null
            : gt("via {environment}", {
                environment: host.viaLabel,
                $context: "machine read through another environment",
              }),
        ]
          .filter((part) => part !== null && part !== "")
          .join(" · ");

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!live}
      className="group flex min-w-0 cursor-pointer flex-col gap-4 rounded-xl border border-border/60 bg-card p-4 text-left transition-colors hover:border-border focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-70 disabled:hover:border-border/60"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <ServerIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{host.label}</p>
          {subtitle === null || subtitle === "" ? null : (
            <p className="truncate text-2xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {snapshot === null ? null : <HostStatusBadge snapshot={snapshot} />}
        {live ? (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
        ) : null}
      </div>
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
        <FleetHostSummary host={host} snapshot={snapshot} />
      )}
    </button>
  );
}

const SUMMARY_ROWS = 6;

function FleetHostSummary({
  host,
  snapshot,
}: {
  readonly host: FleetHost;
  readonly snapshot: HostHealthSnapshot;
}) {
  const gt = useGT();
  const history = useHostHealthHistory(host, "1h").data;
  const root = snapshot.disks[0] ?? null;
  const hottest = hottestSensor(snapshot.sensors);
  const points = history?.points ?? [];
  const timestamps = points.map((point) => point.timestamp);
  const lastAt = timestamps[timestamps.length - 1] ?? 0;
  const toMs = snapshot.sampledAt > lastAt ? snapshot.sampledAt : lastAt;
  const common = {
    timestamps,
    fromMs: toMs - HOST_HEALTH_RANGE_MS["1h"],
    toMs,
    maxGapMs: (history?.resolutionSeconds ?? 10) * 1_000 * 3,
    rows: SUMMARY_ROWS,
    axis: false,
  };
  const memoryTotal = snapshot.memory.totalBytes;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <HealthCard.Hero
            size="md"
            label={<span className={HEALTH_TONES.cpu.title}>{gt("CPU")}</span>}
            value={formatPercent(snapshot.cpu.utilizationPercent)}
          />
          <DotMatrixChart
            {...common}
            tone={HEALTH_TONES.cpu}
            fixedMax={100}
            formatValue={formatPercent}
            series={[
              {
                label: gt("CPU"),
                values: points.map((point) => point.cpuPercent),
                dotClassName: HEALTH_TONES.cpu.dot,
                swatchClassName: HEALTH_TONES.cpu.swatch,
              },
            ]}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <HealthCard.Hero
            size="md"
            label={<span className={HEALTH_TONES.memory.title}>{gt("Memory")}</span>}
            value={formatPercent(usedPercent(snapshot.memory.usedBytes, memoryTotal))}
          />
          <DotMatrixChart
            {...common}
            tone={HEALTH_TONES.memory}
            {...(memoryTotal > 0 ? { fixedMax: memoryTotal } : {})}
            formatValue={formatBytes}
            series={[
              {
                label: gt("Used", { $context: "memory in use" }),
                values: points.map((point) => point.memoryUsedBytes),
                dotClassName: HEALTH_TONES.memory.dot,
                swatchClassName: HEALTH_TONES.memory.swatch,
              },
            ]}
          />
        </div>
      </div>
      <HealthCard.Stats>
        <HealthCard.Stat
          label={root === null ? gt("Disk") : gt("Disk {mount}", { mount: root.mountPoint })}
          value={root === null ? "–" : formatPercent(root.usedPercent)}
        />
        <HealthCard.Stat
          label={gt("Network")}
          value={`↓ ${formatRate(snapshot.network.rxBytesPerSec)}`}
        />
        {hottest === null ? (
          <HealthCard.Stat
            label={gt("Load", { $context: "system load average" })}
            value={snapshot.cpu.load1m.toFixed(2)}
          />
        ) : (
          <HealthCard.Stat label={gt("Temperature")} value={`${hottest.value.toFixed(0)} °C`} />
        )}
      </HealthCard.Stats>
    </div>
  );
}
