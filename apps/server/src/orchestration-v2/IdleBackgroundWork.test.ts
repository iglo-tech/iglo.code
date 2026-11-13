import {
  NodeId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { idleStoppedCommands } from "./IdleBackgroundWork.ts";

const commandItem = (
  id: string,
  fields: Partial<Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>>,
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId: ThreadId.make("thread"),
  runId: RunId.make("run"),
  nodeId: NodeId.make(`node:${id}`),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-11-13T00:00:00.000Z"),
  type: "command_execution",
  input: "",
  ...fields,
});

describe("idleStoppedCommands", () => {
  it("restarts each command where the provider ran it, and skips work that is not a command", () => {
    expect(
      idleStoppedCommands(
        [
          {
            taskId: "dev",
            kind: "command",
            itemId: TurnItemId.make("item:dev"),
            description: "Start the dev server",
          },
          { taskId: "native-watch", kind: "monitor", description: "tail -f log" },
          { taskId: "agent", kind: "subagent", description: "Review" },
          { taskId: "unknown", kind: "command" },
        ],
        [
          commandItem("item:dev", { input: "bun run dev", cwd: "/repo/apps/web" }),
          commandItem("item:watch", {
            input: "tail -f log",
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-watch",
              strength: "strong",
            },
          }),
        ],
      ),
    ).toEqual([
      { command: "bun run dev", label: "Start the dev server", cwd: "/repo/apps/web" },
      { command: "tail -f log" },
    ]);
  });
});
