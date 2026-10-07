import { type Host } from "@t3tools/plugin-host-contract/server";
import {
  type PluginLaunchInput,
  type PluginPullRequestRef,
} from "@t3tools/plugin-host-contract/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type Agent,
  type Data,
  type Definition,
  type Predicate,
  type Run,
  type RunSummary,
  type SkillSnapshot,
} from "./contracts.ts";

type Text = (value: string, limit?: number) => string;
const encodeTexts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeTexts = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

// Redact authored text in one host call. Identities, discriminants and protocol
// values remain usable even when a configured secret happens to equal one.
const redact = <A>(host: Host["Service"], run: Run, project: (text: Text) => A) =>
  Effect.gen(function* () {
    const texts: string[] = [];
    project((value) => {
      texts.push(value);
      return value;
    });
    const visible = yield* host
      .redact({
        text: encodeTexts(texts),
        format: "json",
        threadIds: run.attempts.flatMap((attempt) => (attempt.threadId ? [attempt.threadId] : [])),
      })
      .pipe(Effect.flatMap(decodeTexts));
    let index = 0;
    return project((_value, limit = 4_000) => visible[index++]!.slice(0, limit));
  });

const data = (value: typeof Data.Type, text: Text) =>
  Object.fromEntries(
    Object.entries(value).map(
      ([key, value]) => [key, typeof value === "string" ? text(value) : value] as const,
    ),
  );
const predicate = (value: Predicate, text: Text): Predicate => ({
  ...value,
  ...(value.value === undefined
    ? {}
    : { value: typeof value.value === "string" ? text(value.value) : value.value }),
  ...(value.values === undefined
    ? {}
    : { values: value.values.map((value) => (typeof value === "string" ? text(value) : value)) }),
  ...(value.terms === undefined
    ? {}
    : { terms: value.terms.map((value) => predicate(value, text)) }),
});
const field = (value: Agent["report"]["fields"][number], text: Text) => ({
  ...value,
  ...(value.values === undefined ? {} : { values: value.values.map((value) => text(value)) }),
});
const skill = (value: typeof SkillSnapshot.Type, text: Text) => ({
  ...value,
  invocation: text(value.invocation, Infinity),
  path: text(value.path, Infinity),
  limitation: value.limitation === null ? null : text(value.limitation, Infinity),
});
const agent = <A extends Agent>(value: A, text: Text) => ({
  ...value,
  instruction: text(value.instruction),
  report: { ...value.report, fields: value.report.fields.map((value) => field(value, text)) },
  ...(value.bindings === undefined
    ? {}
    : {
        bindings: value.bindings.map((binding) => ({
          ...binding,
          field: field(binding.field, text),
        })),
      }),
});
const pullRequest = <P extends Omit<PluginPullRequestRef, "projectId">>(value: P, text: Text) => ({
  ...value,
  repository: text(value.repository, Infinity),
  ...(value.host === undefined ? {} : { host: text(value.host, Infinity) }),
});
const workspace = (value: PluginLaunchInput["workspace"], text: Text) =>
  value.type === "existing"
    ? {
        ...value,
        path: text(value.path, Infinity),
        branch: value.branch === null ? null : text(value.branch, Infinity),
      }
    : value.type === "exact-ref" && value.branch !== undefined
      ? { ...value, branch: text(value.branch, Infinity) }
      : value;
const definition = (value: Definition, text: Text): Definition => ({
  ...value,
  title: text(value.title),
  nodes: value.nodes.map((node) => {
    const common = { ...node, title: text(node.title) };
    switch (common.kind) {
      case "agent":
        return agent(common, text);
      case "check":
        return {
          ...common,
          command: text(common.command),
          args: common.args.map((arg) => text(arg)),
        };
      case "parallel":
        return {
          ...common,
          pullRequest: pullRequest(common.pullRequest, text),
          branches: common.branches.map((branch) =>
            agent({ ...branch, title: text(branch.title) }, text),
          ),
        };
      case "decision":
      case "join":
        return {
          ...common,
          rules: common.rules.map((rule) => ({ ...rule, when: predicate(rule.when, text) })),
        };
      default:
        return common;
    }
  }),
});

export const displayRun = (host: Host["Service"], run: Run) =>
  redact(host, run, (text) => ({
    ...run,
    definition: definition(run.definition, text),
    input: data(run.input, text),
    reason: run.reason === null ? null : text(run.reason, Infinity),
    workspace: workspace(run.workspace, text),
    workspacePath: run.workspacePath === null ? null : text(run.workspacePath, Infinity),
    branch: run.branch === null ? null : text(run.branch, Infinity),
    skills: Object.fromEntries(
      Object.entries(run.skills).map(([key, value]) => [key, skill(value, text)]),
    ),
    attempts: run.attempts.map((attempt) => ({
      ...attempt,
      reason: attempt.reason === null ? null : text(attempt.reason, Infinity),
      input: data(attempt.input, text),
      skill: attempt.skill === null ? null : skill(attempt.skill, text),
      launch:
        attempt.launch === null
          ? null
          : {
              ...attempt.launch,
              title: text(attempt.launch.title, Infinity),
              workspace: workspace(attempt.launch.workspace, text),
              ...(attempt.launch.instruction === undefined
                ? {}
                : { instruction: text(attempt.launch.instruction, Infinity) }),
            },
      report:
        attempt.report === null
          ? null
          : {
              ...attempt.report,
              summary: text(attempt.report.summary),
              data: data(attempt.report.data, text),
              evidence: attempt.report.evidence.map((item) => ({
                ...item,
                reference: text(item.reference),
              })),
            },
      check:
        attempt.check === null
          ? null
          : {
              ...attempt.check,
              stdout: text(attempt.check.stdout, Infinity),
              stderr: text(attempt.check.stderr, Infinity),
            },
    })),
    trace: run.trace.map((item) => ({
      ...item,
      reason: text(item.reason, Infinity),
      considered: item.considered.map((choice) => ({
        ...choice,
        predicate: predicate(choice.predicate, text),
      })),
    })),
    reviews: run.reviews.map((review) => ({
      ...review,
      pullRequest: pullRequest(review.pullRequest, text),
    })),
  }));

export const displaySummary = (host: Host["Service"], run: Run, summary: RunSummary) =>
  redact(host, run, (text) => ({
    ...summary,
    definition: { ...summary.definition, title: text(summary.definition.title, 240) },
    reason: summary.reason === null ? null : text(summary.reason, 500),
    attempts: summary.attempts.map((attempt) => ({
      ...attempt,
      reason: attempt.reason === null ? null : text(attempt.reason, 500),
    })),
    trace: summary.trace.map((item) => ({ ...item, reason: text(item.reason, 500) })),
    reviews: summary.reviews.map((review) => ({
      ...review,
      pullRequest: pullRequest(review.pullRequest, text),
    })),
  }));
