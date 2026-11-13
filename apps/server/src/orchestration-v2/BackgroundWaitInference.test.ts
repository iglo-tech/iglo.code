import { expect, it as effectIt } from "@effect/vitest";
import {
  type OrchestrationV2BackgroundWait,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import { recordBackgroundWaits } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, it } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as BackgroundWaitInference from "./BackgroundWaitInference.ts";
import { backgroundWaitCandidates } from "./BackgroundWaitInference.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";

const message = (ordinal: number, text: string) =>
  ({ id: `msg-${ordinal}`, type: "assistant_message", ordinal, text }) as never;
const command = (ordinal: number, nativeId: string, input: string, status = "running") =>
  ({
    id: `cmd-${ordinal}`,
    type: "command_execution",
    ordinal,
    status,
    title: null,
    runId: "run-1",
    nativeItemRef: { nativeId },
    input,
  }) as never;

describe("backgroundWaitCandidates", () => {
  it("asks only about the roster's undecided commands while the run is live", () => {
    const turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [
      message(1, "First I restart the gates."),
      message(2, "Now I start them in the background and wait."),
      command(3, "toolu-gates", "./gates.sh"),
    ];
    expect(
      backgroundWaitCandidates({
        thread: {
          activeProviderThreadId: "pt-1" as never,
          backgroundWaits: [{ taskId: "decided", awaited: false }],
        },
        latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
        runs: [{ id: "run-1" as never, ordinal: 1, status: "running" }],
        providerThreads: [
          {
            id: "pt-1" as never,
            pendingBackgroundTasks: [
              {
                taskId: "gates",
                kind: "command",
                command: "until grep -q DONE status.txt; do sleep 60; done",
                description: "Wait for 184 gates",
                nativeItemId: "toolu-gates",
              },
              { taskId: "tests", kind: "command", command: "bun test", awaited: true },
              { taskId: "decided", kind: "command", command: "bun dev" },
              { taskId: "review", kind: "subagent" },
            ],
          },
        ],
        turnItems,
      }),
    ).toEqual([
      {
        taskId: "gates",
        command: "until grep -q DONE status.txt; do sleep 60; done",
        description: "Wait for 184 gates",
        agentText: "First I restart the gates.\n\nNow I start them in the background and wait.",
      },
    ]);
  });

  it("asks about running command items with the agent's words around them once the run settles", () => {
    expect(
      backgroundWaitCandidates({
        thread: { activeProviderThreadId: null },
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        runs: [{ id: "run-1" as never, ordinal: 1, status: "completed" }],
        providerThreads: [],
        turnItems: [
          message(4, "I'm waiting for the gates, then I decide whether to merge."),
          command(3, "call-1", "until [ -f /tmp/done ]; do sleep 10; done"),
          message(1, "Starting the gates."),
          command(2, "call-0", "bun run build", "completed"),
        ],
      }),
    ).toEqual([
      {
        taskId: "call-1",
        command: "until [ -f /tmp/done ]; do sleep 10; done",
        agentText:
          "Starting the gates.\n\nI'm waiting for the gates, then I decide whether to merge.",
      },
    ]);
  });
});

effectIt.effect(
  "asks once per pass, replaces a live guess once the turn settles, and retries a failure",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-wait-inference");
      const state = {
        runStatus: "running" as "running" | "completed",
        backgroundWaits: undefined as ReadonlyArray<OrchestrationV2BackgroundWait> | undefined,
      };
      const answers: Array<boolean | "fail"> = [true, "fail", false];
      const asked: Array<string> = [];
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      const roster = [{ taskId: "gates", kind: "command" as const, command: "./gates.sh" }];
      const layer = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (() =>
            Effect.sync(() => ({
              thread: {
                id: threadId,
                projectId: "project:background-wait",
                worktreePath: null,
                deletedAt: null,
                archivedAt: null,
                activeProviderThreadId: "pt-1",
                backgroundWaits: state.backgroundWaits,
              },
              runs: [{ id: "run-1", ordinal: 1, status: state.runStatus }],
              providerThreads: [{ id: "pt-1", pendingBackgroundTasks: roster }],
              turnItems: [],
            }))) as never,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              if (command.type === "thread.background-wait.set") {
                state.backgroundWaits =
                  recordBackgroundWaits(state.backgroundWaits, command) ?? state.backgroundWaits;
              }
              return { sequence: dispatched.length, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome({ workspaceRoot: "/home/user/app" } as never),
        }),
        Layer.mock(TextGeneration.TextGeneration)({
          classifyBackgroundTask: (input) =>
            Effect.suspend(() => {
              asked.push(input.command);
              const answer = answers.shift();
              return answer === "fail" || answer === undefined
                ? Effect.fail(new TextGenerationError({ operation: "test", detail: "down" }))
                : Effect.succeed({ wait: answer });
            }),
        }),
        FileSystem.layerNoop({}),
        ServerSettings.layerTest(),
      );
      const reactor = yield* BackgroundWaitInference.make.pipe(Effect.provide(layer));
      const rosterEvent = {
        type: "provider-thread.updated",
        threadId,
        payload: { id: "pt-1", pendingBackgroundTasks: roster },
      } as never;
      const settledEvent = {
        type: "run.updated",
        threadId,
        payload: { id: "run-1", status: "completed" },
      } as never;

      // Two roster updates for one task arrive together; the second only asks for another pass.
      const first = yield* reactor.observe(rosterEvent);
      expect(yield* reactor.observe(rosterEvent)).toBeUndefined();
      yield* Fiber.join(first!);
      expect(asked).toEqual(["./gates.sh"]);
      expect(state.backgroundWaits).toEqual([{ taskId: "gates", awaited: true, inferred: "live" }]);

      // At settle the live guess is asked again; a failure retries with backoff.
      state.runStatus = "completed";
      const settled = yield* reactor.observe(settledEvent);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(settled!);
      expect(asked).toHaveLength(3);
      expect(state.backgroundWaits).toEqual([
        { taskId: "gates", awaited: false, inferred: "settled" },
      ]);
    }),
);
