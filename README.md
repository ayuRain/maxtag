# OpenTag

OpenTag is an open agent-mention runtime for work threads.

The product principle is **Lark first, not Lark only**. The first adapter targets
Feishu/Lark groups and topic threads, while the core runtime is deliberately
platform-neutral so Telegram, Slack, GitHub issues, Linear, or other work surfaces
can be added later.

## Why This Repo

HappyClaw / AgentDock is a strong self-hosted agent workbench: multi-runner,
memory, IM routing, durable outbox, and long-running task mechanics. OpenTag keeps
those lessons, but starts from a different product model:

- OpenTag is organized around shared work threads, not a single local operator.
- Each thread can have an agent identity, tool grants, memory scope, and progress
  surface.
- Agent work should be visible, steerable, and auditable inside the collaboration
  channel.

## Target Shape

```text
@OpenTag in a Lark topic
  -> normalize platform event into SourceThread + SourceMessage
  -> load thread agent identity, access bundle, memory, and default executor
  -> start an AgentRun
  -> update a progress card/checklist while work runs
  -> publish artifacts such as messages, files, reports, or GitHub PRs
```

## Monorepo Layout

```text
apps/server                 HTTP/event ingestion and runtime host
apps/admin                  Admin console placeholder
packages/core               Platform-neutral domain model and runtime contract
packages/platform-lark      Feishu/Lark adapter
packages/platform-telegram  Telegram adapter placeholder
packages/executor-codex     Codex executor placeholder
packages/executor-claude    Claude executor placeholder
packages/tools-github       GitHub tool contract placeholder
packages/memory             Thread/workspace memory stores
packages/ui-cards           Progress/checklist card models
```

## MVP

1. Lark bot installation and event ingestion.
2. Topic/group binding to an OpenTag thread.
3. Thread-level agent identity and access bundle.
4. Live checklist/progress card.
5. Durable outbound delivery and retry.
6. GitHub draft PR loop.
7. Public thread memory with explicit remember/forget commands.

## Local Build

```bash
npm install
npm run build
node apps/server/dist/index.js
```

