import type { ServerDirectEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ownOriginsFor } from "./OwnLinkOrigins.ts";

const tailnetIp: ServerDirectEndpoint = {
  kind: "tailnet",
  httpBaseUrl: "http://100.101.102.103:4773/",
};
const tailnetIpv6: ServerDirectEndpoint = {
  kind: "tailnet",
  httpBaseUrl: "http://[fd7a:115c:a1e0::1]:4773/",
};
const tailnetName: ServerDirectEndpoint = {
  kind: "tailnet",
  httpBaseUrl: "http://box.example.ts.net:4773/",
};
const tailnetServe: ServerDirectEndpoint = {
  kind: "tailnet",
  httpBaseUrl: "https://box.example.ts.net/",
};
const lan: ServerDirectEndpoint = { kind: "lan", httpBaseUrl: "http://192.168.1.10:4773/" };

describe("ownOriginsFor", () => {
  it("offers only the tailnet entries a peer may send credentials to", () => {
    expect(
      ownOriginsFor({ endpoints: [tailnetServe, tailnetName, lan, tailnetIp, tailnetIpv6] }),
    ).toEqual([
      "https://box.example.ts.net",
      "http://box.example.ts.net:4773",
      "http://[fd7a:115c:a1e0::1]:4773",
    ]);
    expect(ownOriginsFor({ endpoints: [lan] })).toEqual([]);
    expect(ownOriginsFor({ endpoints: [] })).toEqual([]);
  });

  // A peer refuses plain http to 100.64.0.0/10, which other VPNs share.
  it("leaves out a Tailscale IPv4 address", () => {
    expect(ownOriginsFor({ endpoints: [tailnetIp] })).toEqual([]);
  });

  it("keeps one of each origin", () => {
    expect(ownOriginsFor({ endpoints: [tailnetServe, { ...tailnetServe }] })).toEqual([
      "https://box.example.ts.net",
    ]);
  });
});
