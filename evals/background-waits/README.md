# Background waits

Checks whether the shipped background-task classifier marks an agent's wait as a wait and leaves dev servers, watchers, and handed-off work alone. It calls `classifyBackgroundTask` through Codex text generation, which grades itself against each case's expected answer. Run from `evals/` with a configured Codex login:

```sh
pnpm background-waits --model <model> --out runs/background-waits
```

Use `--case <id> --samples 1` for a smoke run. By default the six cases run three times each (18 short model calls, about the cost of naming 18 threads). A case fails when half or more of its samples answer wrong. `summary.json` lists failing cases and `results.json` holds every answer.

Add a case to `cases.ts` when a real thread showed a wrong Working or Done state. Name its source, and add a control (a command left running) next to each new wait.
