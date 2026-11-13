// Waits come from a gates wait that showed Done; controls are dev servers that once held threads.
export const cases = [
  {
    id: "gates-loop",
    command:
      "E=~/evidence; sleep 30; until grep -q DONE $E/coord-status.txt 2>/dev/null; do sleep 60; done; cat $E/coord-status.txt",
    description: "Wait for 184 gates",
    agentText:
      "The gates restarted. They're waiting for the shared lock. I'm waiting for the gates, then I decide whether to merge.",
    wait: true,
  },
  {
    id: "file-poll",
    command: "until [ -f /tmp/t3-done ]; do sleep 10; done",
    agentText: "I started the loop in the background and I'm waiting for it to finish.",
    wait: true,
  },
  {
    id: "custom-script",
    command: "./scripts/qa.sh --full",
    description: "Run full QA",
    agentText: "QA takes about ten minutes. Once it finishes I'll fix whatever fails.",
    wait: true,
  },
  {
    id: "dev-server",
    command: "bun run dev",
    description: "Start dev server",
    agentText: "The dev server is running on localhost:3000. Open it to try the new page.",
    wait: false,
  },
  {
    id: "watcher-handoff",
    command: "vp test --watch",
    description: "Watch tests",
    agentText: "Tests rerun on every save. Tell me when you want me to stop the watcher.",
    wait: false,
  },
  {
    id: "e2e-handoff",
    command: "bun run e2e:full",
    agentText:
      "I kicked off the full e2e suite for you. It takes a while; check its output whenever you like.",
    wait: false,
  },
] as const;
