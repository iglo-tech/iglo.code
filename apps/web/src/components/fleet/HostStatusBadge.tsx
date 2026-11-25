import type { HostHealthSnapshot } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { hostHealthStatus } from "./hostHealthFormat";

export function HostStatusBadge({ snapshot }: { readonly snapshot: HostHealthSnapshot }) {
  const gt = useGT();
  const status = hostHealthStatus(snapshot);
  const count = snapshot.alerts.length;
  if (status === "ok") {
    return (
      <Badge variant="success">
        <CheckIcon />
        {gt("Healthy", { $context: "host health status" })}
      </Badge>
    );
  }
  return (
    <Badge variant={status === "critical" ? "error" : "warning"}>
      <AlertTriangleIcon />
      {status === "critical"
        ? gt("Critical · {count}", { count, $context: "host health status with alert count" })
        : gt("Warning · {count}", { count, $context: "host health status with alert count" })}
    </Badge>
  );
}
