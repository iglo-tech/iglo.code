# iglo.code

iglo.code is my personal fork of [T3 Code](https://t3.codes), with workflows inspired by [Cezar](https://cezar.run) and a few changes for how I work.

I'm taking what I like from both and tweaking it for my own use. This is an unofficial personal setup, not a separate product. The name lets me tell it apart from the original apps when I use them side by side.

## Workflows

I want to define how a task should be handled once, then reuse that process: implement a change, run checks, get independent reviews, fix what needs fixing, and bring the result back for my approval.

A workflow should let me choose the agents and skills for each step, get several reviews of the same change at once, and set clear rules for moving forward or going back for changes. Rework needs a limit, and the final decision stays with me.

This should feel like part of everyday coding. Conversations, changes, reviews, and questions belong together, so I can see what happened and what needs me without chasing separate threads. The process should be easy to follow whether I'm at my desk or working remotely.

## Customizations

The rest of the fork is for small fixes and personal preferences: changes to skill handling, defaults, and the interface that help in daily use. I want to keep the app familiar and continue benefiting from T3 Code's improvements.

This fork ships the web client and server. The desktop and native mobile apps and their build tooling are removed so agents focus on the client I use. To bring in upstream improvements and reapply those removals, use the repo-local [$sync-upstream](./.agents/skills/sync-upstream/SKILL.md) skill.

[Local setup and development](./docs/operations/development.md) · [User guides](./docs) · [MIT license](./LICENSE)
