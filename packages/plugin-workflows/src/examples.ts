import { Definition } from "./contracts.ts";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(Definition);
const sequentialExamples: ReadonlyArray<Definition> = [
  decode({
    version: 1,
    id: "implementation",
    revision: 1,
    title: "Implementation and human review",
    entry: "implement",
    atLimit: "review",
    nodes: [
      {
        id: "implement",
        title: "Implement",
        kind: "agent",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
        instruction: "Implement the requested work. Submit a typed report with your evidence.",
        report: {
          fields: [{ name: "ready", type: "boolean", required: true }],
          evidenceRequired: true,
        },
        next: { to: "review" },
      },
      {
        id: "review",
        title: "Human review",
        kind: "human",
        approve: { to: "done" },
        changes: { to: "implement", repeat: { max: 1, atLimit: "review" } },
      },
      { id: "done", title: "Done", kind: "end", outcome: "completed" },
    ],
  }),
];

/** Copy and configure the PR, check command and installed provider/model before running. */
export const developmentReview = decode({
  version: 1,
  id: "development-review",
  revision: 1,
  title: "Implementation, checks and three PR reviews",
  entry: "implement",
  atLimit: "human",
  maxVisits: 40,
  nodes: [
    {
      id: "implement",
      kind: "agent",
      title: "Implement",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      instruction:
        "Implement the requested work, commit it and update the configured PR head. Include commit/check evidence in your report.",
      report: {
        fields: [{ name: "ready", type: "boolean", required: true }],
        evidenceRequired: true,
      },
      next: { to: "checks" },
    },
    {
      id: "checks",
      kind: "check",
      title: "Project checks",
      command: "vp",
      args: ["test", "run"],
      next: { to: "check-result" },
    },
    {
      id: "check-result",
      kind: "decision",
      title: "Check result",
      source: "checks",
      rules: [{ when: { op: "eq", path: "exitCode", value: 0 }, route: { to: "reviews" } }],
      otherwise: { to: "human" },
    },
    {
      id: "reviews",
      kind: "parallel",
      title: "Frozen PR reviews",
      pullRequest: { repository: "OWNER/REPOSITORY", number: 1 },
      branches: [
        {
          id: "code",
          title: "Code",
          skill: "code-review",
          instruction: "Review correctness and maintainability of the frozen PR head.",
        },
        {
          id: "security",
          title: "Security",
          skill: "code-review",
          instruction: "Review security boundaries and exposure in the frozen PR head.",
        },
        {
          id: "ux",
          title: "UX",
          instruction: "Review usability and interaction behavior of the frozen PR head.",
        },
      ].map((branch) => ({
        ...branch,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        report: {
          fields: [
            {
              name: "verdict",
              type: "enum",
              required: true,
              values: ["pass", "changes", "blocker"],
            },
          ],
          evidenceRequired: true,
        },
      })),
      next: "join",
    },
    {
      id: "join",
      kind: "join",
      title: "Wait for all reviews",
      fork: "reviews",
      rules: [
        { when: { op: "ne", path: "result", value: "all_completed" }, route: { to: "unresolved" } },
        {
          when: {
            op: "any",
            terms: ["code", "security", "ux"].map((id) => ({
              op: "in",
              path: `branches.${id}.data.verdict`,
              values: ["changes", "blocker"],
            })),
          },
          route: { to: "rework" },
        },
      ],
      otherwise: { to: "human" },
    },
    {
      id: "rework",
      kind: "decision",
      title: "Bounded rework",
      source: "join",
      rules: [],
      otherwise: { to: "implement", repeat: { max: 1, atLimit: "human" } },
    },
    {
      id: "human",
      kind: "human",
      title: "Human review",
      approve: { to: "done" },
      changes: { to: "unresolved" },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
    { id: "unresolved", kind: "end", title: "Review requires recovery", outcome: "unresolved" },
  ],
});

export const examples: ReadonlyArray<Definition> = [...sequentialExamples, developmentReview];
