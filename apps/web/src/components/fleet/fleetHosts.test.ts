import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fleetHosts, type FleetDirectEnvironment } from "./fleetHosts";

const id = (value: string) => EnvironmentId.make(value);
const direct = (
  value: string,
  label: string,
  overrides: Partial<FleetDirectEnvironment> = {},
): FleetDirectEnvironment => ({
  environmentId: id(value),
  label,
  connected: true,
  supportsHostHealth: true,
  canReadDiagnostics: true,
  ...overrides,
});
const summary = (hosts: ReturnType<typeof fleetHosts>) =>
  hosts.map((host) => [host.label, host.availability, host.viaLabel]);

describe("fleetHosts", () => {
  it("puts this machine first, then readable machines, then the rest", () => {
    expect(
      summary(
        fleetHosts({
          primaryEnvironmentId: id("laptop"),
          direct: [
            direct("old", "Attic", { supportsHostHealth: false }),
            direct("nas", "NAS"),
            direct("away", "Cabin", { connected: false }),
            direct("laptop", "Laptop"),
            direct("guest", "Guest", { canReadDiagnostics: false }),
          ],
          linkSources: [],
        }),
      ),
    ).toEqual([
      ["Laptop", "live", null],
      ["NAS", "live", null],
      ["Attic", "unsupported", null],
      ["Cabin", "offline", null],
      ["Guest", "forbidden", null],
    ]);
  });

  it("adds machines only a link reaches, and reads an offline connection through a link", () => {
    expect(
      summary(
        fleetHosts({
          primaryEnvironmentId: id("laptop"),
          direct: [direct("laptop", "Laptop"), direct("box", "Box", { connected: false })],
          linkSources: [
            {
              environmentId: id("laptop"),
              label: "Laptop",
              links: [
                { environmentId: id("box"), label: "box (linked)" },
                { environmentId: id("vps"), label: "VPS" },
                { environmentId: id("laptop"), label: "Laptop" },
              ],
            },
          ],
        }),
      ),
    ).toEqual([
      ["Laptop", "live", null],
      // The connection's own name wins over the link's.
      ["Box", "live", "Laptop"],
      ["VPS", "live", "Laptop"],
    ]);
  });

  it("keeps a working connection over a link, and the first link over later ones", () => {
    const hosts = fleetHosts({
      primaryEnvironmentId: null,
      direct: [direct("nas", "NAS")],
      linkSources: [
        {
          environmentId: id("a"),
          label: "A",
          links: [
            { environmentId: id("nas"), label: "NAS" },
            { environmentId: id("vps"), label: "VPS" },
          ],
        },
        { environmentId: id("b"), label: "B", links: [{ environmentId: id("vps"), label: "VPS" }] },
      ],
    });
    expect(summary(hosts)).toEqual([
      ["NAS", "live", null],
      ["VPS", "live", "A"],
    ]);
  });
});
