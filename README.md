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
apps/admin                  Operator console for projects, routines, runs, and memory
packages/core               Platform-neutral domain model and runtime contract
packages/config             Workspace/project agent policy and audit store
packages/platform-lark      Feishu/Lark adapter
packages/platform-telegram  Telegram adapter placeholder
packages/executor-cli       Bounded, cancellable local CLI process runtime
packages/executor-codex     Codex dry-run and local CLI executor
packages/executor-claude    Claude dry-run and local CLI executor
packages/runtime-host       Shared runtime host for independent workers
packages/tools-github       GitHub tool contract placeholder
packages/memory             Global/workspace/project/thread memory stores
packages/routines           Scheduled work, execution claims, and audit history
packages/delivery           Durable outbox, delivery tracking, bindings
packages/ui-cards           Progress/checklist card models
```

## Current Capability

- Lark event ingestion path, progress card rendering, and selectable memory/http
  Lark transport are wired.
- The core model is client-neutral: Lark, Telegram, Slack, and GitHub comments
  are clients of the same runtime contract.
- Non-Lark clients can enter through `/v1/client/events`, which normalizes a
  client envelope into the same run queue, scoped memory, and delivery ledger.
- Memory is scoped into global, workspace, project, and thread files.
- Workspace and project agent policies are persisted separately from memory,
  including identity, instructions, executor choice, project tool grants,
  network policy, and an admin change audit.
- Codex and Claude executors are selected per project. They support safe-by-default
  dry-runs or explicit local CLI execution, and the standalone worker resolves
  the same policy and runtime mode as the HTTP server.
- Dry-run Lark delivery now runs through a file-backed outbox, per-run delivery
  records, and thread-to-project bindings.
- Delivery recovery can requeue stale `sending` records and cancel only the
  selected run/thread/workspace/project scope.
- Agent runs are recorded in a file-backed run ledger with status, timeline
  events, and cancel requests.
- Agent execution can be enqueued into a durable run queue and claimed by an
  inline worker, with stale run recovery on startup and through the admin API.
- Agent execution can also be claimed by the standalone `apps/worker` process
  against the same `OPENTAG_DATA_DIR`.
- Workspace and project routines support interval or IANA-time-zone daily
  schedules, client-neutral destinations, manual triggers, deterministic run
  bridging, deduplication, and stale execution reclaim. Routine work enters the
  same run queue, executor policy, memory scopes, and delivery path as messages.
- Real Lark delivery can be enabled with `OPENTAG_LARK_TRANSPORT=http`,
  `OPENTAG_LARK_APP_ID`, and `OPENTAG_LARK_APP_SECRET`; use
  `OPENTAG_LARK_DOMAIN=lark` for international Lark.
- Lark callbacks are recorded in an inbound event ledger with verification-token
  checks, replay-window checks, duplicate short-circuiting, and processed/ignored
  states.
- Lark group `chat_id` maps into the project route, so one workspace bot can
  serve multiple group/project memories instead of collapsing into one global
  thread.
- Lark topic continuation is supported: a mention can establish a thread binding,
  then later messages in that topic continue without repeating the mention.
- Non-Lark delivery uses tracked text receipts in the outbox until a real
  platform transport is wired.
- Channel/project bindings can be configured through the admin API and console,
  including mention-only vs always-on activation.
- Scoped memory can be viewed and updated through `/v1/memory`, the admin
  console, or chat commands such as `remember project ...` and
  `forget project ...`.
- The admin console exposes Overview, Projects, Routines, Activity, and Memory
  workspaces, with project policy editing, channel binding, scheduler controls,
  routine execution history, run timelines, delivery ledgers, and a
  project-aware Lark preview.

## MVP

1. Lark bot installation and event ingestion.
2. Topic/group binding to an OpenTag thread.
3. Workspace/project/thread routing for one global workspace bot.
4. Live checklist/progress card.
5. Thread-level agent identity and access bundle.
6. Durable outbound delivery, retry, scoped cancel, and stale recovery.
7. GitHub draft PR loop.
8. Production database backing, independent worker deployment, and full run
   resume.

## Local Build

```bash
npm install
npm run build
npm run dev
```

Open `http://127.0.0.1:3077`. Use
`node apps/server/dist/index.js` instead when file watching is not needed.

To split HTTP ingestion from execution, run the server without its inline worker
and start the worker separately:

```bash
OPENTAG_AGENT_WORKER=manual node apps/server/dist/index.js
npm run worker
```

For one-shot smoke tests, set `OPENTAG_WORKER_ONCE=1`; tune claim batch size with
`OPENTAG_WORKER_BATCH`.

## Routines

The server scheduler is enabled by default. It persists routines and execution
history under `OPENTAG_DATA_DIR`, stages due work without catch-up floods, and
bridges each execution into a deterministic agent run. Configure it with:

```bash
OPENTAG_ROUTINES_ENABLED=true
OPENTAG_ROUTINE_TICK_INTERVAL_MS=30000
OPENTAG_ROUTINE_CLAIM_STALE_MS=120000
OPENTAG_DEFAULT_TIME_ZONE=Asia/Shanghai
```

Use the **Routines** console to create interval or daily work, choose a project
and client destination, trigger a manual run, and open the corresponding run
timeline. `POST /v1/routines/tick` is available for an operator or external
supervisor. Local development still uses the configured dry-run executor and
memory Lark transport unless those modes are explicitly changed.

## Local CLI Executors

Real Codex or Claude execution is opt-in. Both CLIs must already be installed and
authenticated for the service account running OpenTag:

```bash
OPENTAG_EXECUTOR_MODE=local-cli
OPENTAG_EXECUTOR_WORKSPACE_ROOT=/srv/opentag/workspaces
OPENTAG_EXECUTOR_TIMEOUT_MS=1200000
```

OpenTag uses `<workspace root>/<project id>` when that directory exists, falling
back to the configured root. Projects without `shell` or `github` grants run
Codex read-only; Claude receives only repository read tools. The process runner
kills the full child process group on cancellation or timeout, bounds retained
stdout/stderr, and filters service secrets such as Lark credentials from the CLI
environment. Additional variables must be named explicitly through
`OPENTAG_EXECUTOR_INHERIT_ENV`.

`deny-by-default` and `allow-all` network policy map onto the Codex workspace
sandbox. Claude built-in web tools are enabled only for an `allow-all` project
with a `browser` grant. Host-level enforcement for Claude shell networking still
requires deploying the worker in a container or OS sandbox.

## Generic Client Ingress

Use `/v1/client/events` when wiring a new platform adapter before the native
webhook transport is ready:

```bash
curl -X POST 'http://127.0.0.1:3077/v1/client/events' \
  -H 'content-type: application/json' \
  -d '{
    "platform": "telegram",
    "eventId": "tg-event-1",
    "thread": {
      "externalId": "tg-chat-42",
      "channelId": "tg-chat-42",
      "workspaceId": "dev-workspace",
      "projectId": "opentag",
      "visibility": "public"
    },
    "message": {
      "id": "tg-message-1",
      "text": "/opentag summarize this repo",
      "actor": { "id": "tg-user-1", "displayName": "Ada" }
    }
  }'
```

Public generic clients require `mentionsAgent: true`, an `/opentag` or
`@opentag` trigger, or an already established thread with `rootMessageId` or
`topicId`. Chat-only events do not silently turn a whole group into an active
session.

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
