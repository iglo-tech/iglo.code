import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type LinkingEnvironment, planLinkedAutoConnect } from "./linkedAutoConnect.ts";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const vps = EnvironmentId.make("vps");
const link = (environmentId: EnvironmentId) => ({ environmentId, label: `${environmentId} box` });
const machine = (
  environmentId: EnvironmentId,
  links: ReadonlyArray<EnvironmentId> | null,
  extra: Partial<LinkingEnvironment> = {},
): LinkingEnvironment => ({
  environmentId,
  links: links === null ? null : links.map(link),
  mayPair: true,
  ...extra,
});
const empty = { connect: [], forget: [], clearMarks: [], clearWaits: [] };

describe("planLinkedAutoConnect", () => {
  it("joins every machine a machine of this device links to, through it", () => {
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, [server, vps])],
        marked: new Set(),
      }),
    ).toEqual({
      ...empty,
      connect: [
        { environmentId: server, via: laptop, label: "server box" },
        { environmentId: vps, via: laptop, label: "vps box" },
      ],
    });
  });

  it("follows chains through machines it joined", () => {
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, [server]), machine(server, [laptop, vps])],
        marked: new Set([server]),
      }).connect,
    ).toEqual([{ environmentId: vps, via: server, label: "vps box" }]);
  });

  it("joins only through a machine that lets this device pair", () => {
    const plan = (mayPair: boolean) =>
      planLinkedAutoConnect({
        environments: [
          machine(laptop, [server], { mayPair: false }),
          machine(vps, [server], { mayPair }),
        ],
        marked: new Set(),
      }).connect;
    expect(plan(false)).toEqual([]);
    expect(plan(true)).toEqual([{ environmentId: server, via: vps, label: "server box" }]);
  });

  it("does nothing before the catalog has loaded", () => {
    expect(planLinkedAutoConnect({ environments: [], marked: new Set([server]) })).toEqual(empty);
  });

  it("leaves a joined machine once its link goes, even while it is offline", () => {
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, []), machine(server, null)],
        marked: new Set([server]),
      }).forget,
    ).toEqual([server]);
  });

  it("leaves joined machines that only link to each other", () => {
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, []), machine(server, [vps]), machine(vps, [server])],
        marked: new Set([server, vps]),
      }).forget,
    ).toEqual([server, vps]);
  });

  it("keeps machines paired by hand, and the one serving this app", () => {
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, [], { primary: true }), machine(server, [])],
        marked: new Set([laptop]),
      }),
    ).toEqual({ ...empty, clearMarks: [laptop] });
  });

  it("leaves nothing while a reached machine's links are unknown", () => {
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, null), machine(server, [])],
        marked: new Set([server]),
      }),
    ).toEqual(empty);
  });

  it("does not rejoin a linked machine removed by hand, until its link goes", () => {
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, [server])],
        marked: new Set([server]),
      }),
    ).toEqual(empty);
    expect(
      planLinkedAutoConnect({
        environments: [machine(laptop, [])],
        marked: new Set([server]),
      }).clearMarks,
    ).toEqual([server]);
  });

  it("waits on a machine that could not be joined, and forgets the wait once unlinked", () => {
    const plan = (links: ReadonlyArray<EnvironmentId>) =>
      planLinkedAutoConnect({
        environments: [machine(laptop, links)],
        marked: new Set(),
        waiting: new Set([server]),
      });
    expect(plan([server])).toEqual(empty);
    expect(plan([]).clearWaits).toEqual([server]);
  });
});
