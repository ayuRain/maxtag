# OpenTag

OpenTag is an open agent-mention runtime for work threads.

The product principle is **Lark first, not Lark only**. Feishu/Lark groups and
topic threads remain the first product surface, Telegram is the second native
client, and the core runtime stays platform-neutral for Slack, GitHub, Linear,
or future work surfaces.

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
@OpenTag in Lark or /opentag in a Telegram topic
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
packages/platform-telegram  Telegram webhook and Bot API adapter
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
- Telegram has native Bot API webhook ingestion, secret validation, update
  idempotency, chat/forum-topic normalization, editable progress messages,
  long-message chunking, topic replies, outgoing files, and memory/http
  transports.
- The core model is client-neutral: Lark, Telegram, Slack, and GitHub comments
  are clients of the same runtime contract.
- Other clients can enter through `/v1/client/events`, which normalizes a
  client envelope into the same run queue, scoped memory, and delivery ledger.
  Deployments can protect this adapter-only ingress with its own Bearer token.
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
- Lark and Telegram users can create, list, pause, resume, or delete standing
  work in the current project/topic. Each change is scoped to that conversation
  and records the requesting user for audit.
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
- Clients without a native adapter use tracked text receipts in the outbox until
  a real platform transport is wired.
- Channel/project bindings can be configured through the admin API and console,
  including mention-only vs always-on activation.
- Lark and Telegram chats can self-connect to a project with a short-lived,
  single-use `/pair` command generated in the Connectors console. Only a salted
  code hash is persisted, and unbinding a chat also clears its observed topic
  routes.
- Scoped memory can be viewed and updated through `/v1/memory`, the admin
  console, or chat commands such as `remember project ...` and
  `forget project ...`.
- The admin console exposes Overview, Projects, Connectors, Routines, Activity,
  and Memory workspaces, with project policy editing, self-service chat pairing,
  channel unbinding, scheduler controls, routine execution history, run
  timelines, delivery ledgers, and a project-aware client preview.
- Operator authentication is opt-in for local development and required for a
  shared deployment. It supports Bearer automation and signed, expiring,
  HttpOnly browser sessions with CSRF protection for mutations.

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

## Operator Authentication

Local loopback development remains open when `OPENTAG_ADMIN_TOKEN` is unset.
Before binding the server to a shared interface, configure a random token of at
least 24 characters:

```bash
export OPENTAG_ADMIN_TOKEN="$(openssl rand -hex 32)"
export OPENTAG_ADMIN_SESSION_TTL_SECONDS=28800
export OPENTAG_ADMIN_COOKIE_SECURE=true
npm run dev
```

The console exchanges that token for a signed, expiring `HttpOnly` session
cookie. Scripts can send the token directly:

```bash
curl -H "Authorization: Bearer $OPENTAG_ADMIN_TOKEN" \
  http://127.0.0.1:3077/v1/workspace
```

`/health`, static console assets, and native Lark/Telegram callbacks remain
outside the operator session boundary; the native callbacks retain their own
verification token or webhook secret. Generic adapters use a separate
`OPENTAG_CLIENT_INGRESS_TOKEN` Bearer credential. When operator authentication
is enabled without that credential, `/v1/client/events` is disabled instead of
accepting anonymous events.

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

Standing work can also be managed directly in a bound Lark or Telegram topic:

```text
schedule every 30m: Check CI failures
schedule daily 09:00 Asia/Shanghai: Summarize open work
routines
pause routine <id>
resume routine <id>
delete routine <id>
```

Chinese interval and daily forms such as `每 30 分钟：检查 CI` and
`每天 09:00：汇总项目进展` are supported as well. Commands only see routines
for the current project and conversation destination.

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

Use `/v1/client/events` when prototyping a client before its native webhook
transport is ready:

```bash
curl -X POST 'http://127.0.0.1:3077/v1/client/events' \
  -H 'content-type: application/json' \
  -d '{
    "platform": "custom-chat",
    "eventId": "chat-event-1",
    "thread": {
      "externalId": "chat-42",
      "channelId": "chat-42",
      "workspaceId": "dev-workspace",
      "projectId": "opentag",
      "visibility": "public"
    },
    "message": {
      "id": "chat-message-1",
      "text": "/opentag summarize this repo",
      "actor": { "id": "user-1", "displayName": "Ada" }
    }
  }'
```

Public generic clients require `mentionsAgent: true`, an `/opentag` or
`@opentag` trigger, or an already established thread with `rootMessageId` or
`topicId`. Chat-only events do not silently turn a whole group into an active
session.

## Chat Pairing

Open **Connectors**, choose Lark or Telegram and a target project, then generate
an invitation. Send the returned command in the chat that should serve that
project:

```text
/pair ABCD-2345
```

Invitations expire after five minutes by default, are single-use, and are bound
to the selected client. Consuming one creates a configured channel route with
the chosen activation policy; the same workspace bot can therefore serve many
projects without sharing project or thread memory. Configure the gate and TTL
with:

```bash
OPENTAG_LARK_REQUIRE_BINDING=true
OPENTAG_TELEGRAM_REQUIRE_BINDING=true
OPENTAG_PAIRING_TTL_SECONDS=300
```

The file-backed pairing and binding stores are suitable for local development
and a single process. Operator authentication protects the current console and
APIs, but pairing consumption and binding creation still need one transactional
database operation before running multiple replicas.

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

## Telegram Delivery Mode

Local development defaults to `OPENTAG_TELEGRAM_TRANSPORT=memory`, so native
updates can be exercised without calling Telegram. For a real bot:

```bash
OPENTAG_TELEGRAM_TRANSPORT=http
OPENTAG_TELEGRAM_BOT_TOKEN=123456:token
OPENTAG_TELEGRAM_BOT_USERNAME=OpenTagBot
OPENTAG_TELEGRAM_WEBHOOK_SECRET=replace-with-a-random-secret
OPENTAG_TELEGRAM_WORKSPACE_ID=dev-workspace
```

Register `https://your-host/v1/telegram/events` as the bot webhook and pass the
same secret as `secret_token` when calling Telegram `setWebhook`. Set
`OPENTAG_TELEGRAM_REQUIRE_BINDING=true` when only chats paired or explicitly
configured in the OpenTag **Connectors** view should be accepted. Supergroup forum
`message_thread_id` values become stable OpenTag threads; channel bindings map
those topics to project-scoped identity, grants, and memory.

Incoming Telegram file IDs are retained in attachment metadata. Automatic file
download is still pending; local outbound artifacts are already uploaded with
`sendDocument`.
