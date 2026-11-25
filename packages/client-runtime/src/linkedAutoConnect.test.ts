import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planLinkedAutoConnect } from "./linkedAutoConnect.ts";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const vps = EnvironmentId.make("vps");
const link = (environmentId: EnvironmentId) => ({ environmentId, label: `${environmentId} box` });

describe("planLinkedAutoConnect", () => {
  it("joins every machine a connected machine links to, through it", () => {
    expect(
      planLinkedAutoConnect({
        registered: [laptop],
        linking: [{ environmentId: laptop, links: [link(server), link(vps)], mayPair: true }],
        marked: new Set(),
      }),
    ).toEqual({
      connect: [
        { environmentId: server, via: laptop, label: "server box" },
        { environmentId: vps, via: laptop, label: "vps box" },
      ],
      forget: [],
      clearMarks: [],
    });
  });

  it("joins only through a machine that lets this device pair", () => {
    const plan = (mayPair: boolean) =>
      planLinkedAutoConnect({
        registered: [laptop, vps],
        linking: [
          { environmentId: laptop, links: [link(server)], mayPair: false },
          { environmentId: vps, links: [link(server)], mayPair },
        ],
        marked: new Set(),
      }).connect;
    expect(plan(false)).toEqual([]);
    expect(plan(true)).toEqual([{ environmentId: server, via: vps, label: "server box" }]);
  });

  it("leaves machines this device already has alone", () => {
    expect(
      planLinkedAutoConnect({
        registered: [laptop, server],
        linking: [
          { environmentId: laptop, links: [link(server)], mayPair: true },
          { environmentId: server, links: [link(laptop)], mayPair: true },
        ],
        marked: new Set(),
      }),
    ).toEqual({ connect: [], forget: [], clearMarks: [] });
  });

  it("leaves a machine joined through a link once nothing links to it", () => {
    expect(
      planLinkedAutoConnect({
        registered: [laptop, server],
        linking: [
          { environmentId: laptop, links: [], mayPair: true },
          { environmentId: server, links: [], mayPair: true },
        ],
        marked: new Set([server]),
      }).forget,
    ).toEqual([server]);
  });

  it("keeps a machine paired by hand when its link goes", () => {
    expect(
      planLinkedAutoConnect({
        registered: [laptop, server],
        linking: [
          { environmentId: laptop, links: [], mayPair: true },
          { environmentId: server, links: [], mayPair: true },
        ],
        marked: new Set(),
      }).forget,
    ).toEqual([]);
  });

  it("leaves nothing while a machine's links are unknown", () => {
    expect(
      planLinkedAutoConnect({
        registered: [laptop, server, vps],
        linking: [
          { environmentId: laptop, links: null, mayPair: true },
          { environmentId: server, links: [], mayPair: true },
          { environmentId: vps, links: [], mayPair: true },
        ],
        marked: new Set([server]),
      }),
    ).toEqual({ connect: [], forget: [], clearMarks: [] });
  });

  it("does not rejoin a linked machine removed by hand, until its link goes", () => {
    const linked = planLinkedAutoConnect({
      registered: [laptop],
      linking: [{ environmentId: laptop, links: [link(server)], mayPair: true }],
      marked: new Set([server]),
    });
    expect(linked).toEqual({ connect: [], forget: [], clearMarks: [] });
    const unlinked = planLinkedAutoConnect({
      registered: [laptop],
      linking: [{ environmentId: laptop, links: [], mayPair: true }],
      marked: new Set([server]),
    });
    expect(unlinked.clearMarks).toEqual([server]);
  });

  it("leaves a machine that could not be joined lately alone until its wait is over", () => {
    const plan = (waiting: ReadonlySet<EnvironmentId>) =>
      planLinkedAutoConnect({
        registered: [laptop],
        linking: [{ environmentId: laptop, links: [link(server)], mayPair: true }],
        marked: new Set(),
        waiting,
      }).connect;
    expect(plan(new Set([server]))).toEqual([]);
    expect(plan(new Set())).toEqual([{ environmentId: server, via: laptop, label: "server box" }]);
  });
});
