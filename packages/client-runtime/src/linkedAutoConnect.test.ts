import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_LINKED_AUTO_CONNECT_PLAN as empty,
  type LinkingEnvironment,
  planLinkedAutoConnect,
} from "./linkedAutoConnect.ts";

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
const plan = (
  environments: ReadonlyArray<LinkingEnvironment>,
  sets: {
    joined?: ReadonlyArray<EnvironmentId>;
    dismissed?: ReadonlyArray<EnvironmentId>;
    waiting?: ReadonlyArray<EnvironmentId>;
  } = {},
) =>
  planLinkedAutoConnect({
    environments,
    joined: new Set(sets.joined),
    dismissed: new Set(sets.dismissed),
    waiting: new Set(sets.waiting),
  });

describe("planLinkedAutoConnect", () => {
  it("joins every machine a machine of this device links to, through it", () => {
    expect(plan([machine(laptop, [server, vps])])).toEqual({
      ...empty,
      connect: [
        { environmentId: server, via: laptop, label: "server box" },
        { environmentId: vps, via: laptop, label: "vps box" },
      ],
    });
  });

  it("follows chains through machines it joined", () => {
    expect(
      plan([machine(laptop, [server]), machine(server, [laptop, vps])], { joined: [server] })
        .connect,
    ).toEqual([{ environmentId: vps, via: server, label: "vps box" }]);
  });

  it("joins only through a machine that lets this device pair", () => {
    const connect = (mayPair: boolean) =>
      plan([machine(laptop, [server], { mayPair: false }), machine(vps, [server], { mayPair })])
        .connect;
    expect(connect(false)).toEqual([]);
    expect(connect(true)).toEqual([{ environmentId: server, via: vps, label: "server box" }]);
  });

  it("does nothing before the catalog has loaded", () => {
    expect(plan([], { joined: [server] })).toEqual(empty);
  });

  it("leaves a joined machine once its link goes, even while it is offline", () => {
    expect(plan([machine(laptop, []), machine(server, null)], { joined: [server] }).forget).toEqual(
      [server],
    );
  });

  it("leaves joined machines that only link to each other", () => {
    expect(
      plan([machine(laptop, []), machine(server, [vps]), machine(vps, [server])], {
        joined: [server, vps],
      }).forget,
    ).toEqual([server, vps]);
  });

  it("keeps machines paired by hand, and the one serving this app", () => {
    expect(
      plan([machine(laptop, [], { primary: true }), machine(server, [])], { joined: [laptop] }),
    ).toEqual({ ...empty, clearJoined: [laptop] });
  });

  it("leaves nothing while a reached machine's links were never known", () => {
    expect(plan([machine(laptop, null), machine(server, [])], { joined: [server] })).toEqual(empty);
  });

  it("does not rejoin a machine removed by hand while it is linked, and forgets that once unlinked", () => {
    expect(plan([machine(laptop, [server])], { dismissed: [server] })).toEqual(empty);
    expect(plan([machine(laptop, [])], { dismissed: [server] }).clearDismissed).toEqual([server]);
  });

  it("joins again a joined machine missing from this device", () => {
    expect(plan([machine(laptop, [server])], { joined: [server] }).connect).toEqual([
      { environmentId: server, via: laptop, label: "server box" },
    ]);
  });

  it("joins afresh a joined machine that refuses this device", () => {
    const refused = plan(
      [machine(laptop, [server]), machine(server, [laptop], { refused: true })],
      {
        joined: [server],
      },
    );
    expect(refused.rejoin).toEqual([server]);
    expect(refused.forget).toEqual([]);
  });

  it("waits on a machine that could not be joined, and forgets the wait once unlinked", () => {
    expect(plan([machine(laptop, [server])], { waiting: [server] })).toEqual(empty);
    expect(plan([machine(laptop, [])], { waiting: [server] }).clearWaits).toEqual([server]);
  });
});
