import type { ServerDirectEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ownOriginsFor } from "./OwnLinkOrigins.ts";

const tailnetIp: ServerDirectEndpoint = {
  kind: "tailnet",
  httpBaseUrl: "http://100.101.102.103:4773/",
};
const tailnetServe: ServerDirectEndpoint = {
  kind: "tailnet",
  httpBaseUrl: "https://box.example.ts.net:4773/",
};
const lan: ServerDirectEndpoint = { kind: "lan", httpBaseUrl: "http://192.168.1.10:4773/" };

describe("ownOriginsFor", () => {
  it("offers only the tailnet entries a peer may send credentials to", () => {
    expect(ownOriginsFor({ endpoints: [lan, tailnetIp, tailnetServe] })).toEqual([
      "http://100.101.102.103:4773",
      "https://box.example.ts.net:4773",
    ]);
    expect(ownOriginsFor({ endpoints: [lan] })).toEqual([]);
    expect(ownOriginsFor({ endpoints: [] })).toEqual([]);
  });

  it("keeps one of each origin", () => {
    expect(ownOriginsFor({ endpoints: [tailnetServe, { ...tailnetServe }] })).toEqual([
      "https://box.example.ts.net:4773",
    ]);
  });
});
