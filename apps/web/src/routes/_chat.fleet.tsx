import { createFileRoute } from "@tanstack/react-router";

import { FleetPage, type FleetSearch } from "../components/fleet/FleetPage";
import { isHostHealthRange } from "../components/fleet/hostHealthFormat";

export const Route = createFileRoute("/_chat/fleet")({
  validateSearch: (raw: Record<string, unknown>): FleetSearch => ({
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(isHostHealthRange(raw.range) ? { range: raw.range } : {}),
  }),
  component: FleetPage,
});
