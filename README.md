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
- A workspace-level bot can route many clients into separate projects and
  threads.
- Each thread can have an agent identity, tool grants, scoped memory, and
  progress surface.
- Agent work should be visible, steerable, and auditable inside the collaboration
  channel.

## Target Shape

```text
@OpenTag in a Lark topic
  -> normalize platform event into SourceThread + SourceMessage
  -> resolve workspace/project/thread
  -> load agent identity, access bundle, scoped memory, and default executor
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
packages/memory             Global/workspace/project/thread memory stores
packages/delivery           Durable outbox, delivery tracking, bindings
packages/ui-cards           Progress/checklist card models
```

## Current Capability

- Lark event ingestion path, progress card rendering, and selectable memory/http
  Lark transport are wired.
- The core model is client-neutral: Lark, Telegram, Slack, and GitHub comments
  are clients of the same runtime contract.
- Memory is scoped into global, workspace, project, and thread files.
- Dry-run Lark delivery now runs through a file-backed outbox, per-run delivery
  records, and thread-to-project bindings.
- Delivery recovery can requeue stale `sending` records and cancel only the
  selected run/thread/workspace/project scope.
- Agent runs are recorded in a file-backed run ledger with status, timeline
  events, and cancel requests.
- Real Lark delivery can be enabled with `OPENTAG_LARK_TRANSPORT=http`,
  `OPENTAG_LARK_APP_ID`, and `OPENTAG_LARK_APP_SECRET`; use
  `OPENTAG_LARK_DOMAIN=lark` for international Lark.
- Lark callbacks are recorded in an inbound event ledger with verification-token
  checks, replay-window checks, duplicate short-circuiting, and processed/ignored
  states.
- Lark group `chat_id` maps into the project route, so one workspace bot can
  serve multiple group/project memories instead of collapsing into one global
  thread.
- Channel/project bindings can be configured through the admin API and console,
  including mention-only vs always-on activation.
- Scoped memory can be viewed and updated through `/v1/memory`, the admin
  console, or chat commands such as `remember project ...` and
  `forget project ...`.
- The admin preview exposes client readiness, memory scopes, and AgentDock parity
  gaps.

## MVP

1. Lark bot installation and event ingestion.
2. Topic/group binding to an OpenTag thread.
3. Workspace/project/thread routing for one global workspace bot.
4. Live checklist/progress card.
5. Thread-level agent identity and access bundle.
6. Durable outbound delivery, retry, scoped cancel, and stale recovery.
7. GitHub draft PR loop.
8. Async runner, run resume, and production database backing.

## Local Build

```bash
npm install
npm run build
node apps/server/dist/index.js
```

## Lark Delivery Mode

Local development defaults to `OPENTAG_LARK_TRANSPORT=memory`, which records
messages and cards in the admin preview without calling Lark. To send through a
real app bot:

```bash
OPENTAG_LARK_TRANSPORT=http
OPENTAG_LARK_DOMAIN=feishu
OPENTAG_LARK_APP_ID=cli_xxx
OPENTAG_LARK_APP_SECRET=xxx
```

Use `OPENTAG_LARK_DOMAIN=lark` for `open.larksuite.com`, or
`OPENTAG_LARK_BASE_URL=https://...` for a custom OpenAPI host.
