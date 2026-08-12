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
  -> authorize the platform actor against workspace and project roles
  -> load agent identity, access bundle, scoped memory, and default executor
  -> start an AgentRun
  -> update a progress card/checklist while work runs
  -> publish artifacts such as messages, files, reports, or GitHub PRs
```

## Monorepo Layout

```text
apps/server                 HTTP/event ingestion and runtime host
apps/admin                  Operator console for projects, access, connectors, routines, workflows, runs, and memory
packages/core               Platform-neutral domain model and runtime contract
packages/config             Agent policy, workspace identities, project roles, and audit
packages/platform-lark      Feishu/Lark adapter
packages/platform-telegram  Telegram webhook and Bot API adapter
packages/executor-cli       Bounded, cancellable local CLI process runtime
packages/executor-codex     Codex dry-run and local CLI executor
packages/executor-claude    Claude dry-run and local CLI executor
packages/runtime-host       Shared runtime host for independent workers
packages/tool-broker        Per-run MCP capabilities, provider isolation, and tool audit
packages/tools-github       GitHub artifact and grant contracts
packages/memory             Global/workspace/project/thread memory stores
packages/routines           Scheduled work, execution claims, and audit history
packages/workflows          Durable DAG definitions, event triggers, node claims, and execution history
packages/delivery           Durable outbox, delivery tracking, bindings
packages/storage-sqlite     WAL storage, migration, and atomic control transactions
packages/ui-cards           Progress/checklist card models
```

## Current Capability

- Lark event ingestion, file/image/audio/video resource download, progress card
  rendering, text replies, and native file/image upload are wired behind
  selectable memory/http transports.
- Telegram has native Bot API webhook ingestion, secret validation, update
  idempotency, chat/forum-topic normalization, editable progress messages,
  long-message chunking, topic replies, managed inbound downloads, outgoing
  files, and memory/http transports.
- The core model is client-neutral: Lark, Telegram, Slack, and GitHub comments
  are clients of the same runtime contract.
- Other clients can enter through `/v1/client/events`, which normalizes a
  client envelope into the same run queue, scoped memory, and delivery ledger.
  Deployments can protect this adapter-only ingress with its own Bearer token.
- Memory is scoped into global, workspace, project, and thread documents. In
  the default SQLite mode, every remember, forget, restore, and legacy import
  creates an immutable revision with its trusted operator or client actor.
- Workspace and project agent policies are persisted separately from memory,
  including identity, instructions, executor choice, project tool grants,
  network policy, and an admin change audit.
- Workspace members link stable client identities such as Lark `open_id` or
  Telegram user IDs to workspace roles. Projects can stay open, require any
  active workspace member, or require an explicit project role. Client ingress
  checks separate capabilities for agent invocation, memory writes, and routine
  management before a run is queued.
- Codex and Claude executors are selected per project. They support safe-by-default
  dry-runs or explicit local CLI execution, and the standalone worker resolves
  the same policy and runtime mode as the HTTP server.
- Local Codex and Claude runs receive a short-lived MCP endpoint containing only
  the current run's grants. The broker validates every input schema, enforces
  resource allowlists and call/time/result limits, and records durable call and
  result events. It provides scoped memory, approved GitHub repository and issue
  reads plus issue/comment writes, approved Lark document read/append, and Base
  record query/create/update. Resource writes appear only for explicit project
  write grants. GitHub and Lark credentials stay in the host process.
- Delivery, run, inbound-event, binding, pairing, workspace-access, memory,
  routine, and workflow state defaults to a shared SQLite WAL database. Outbox,
  run, routine, and workflow-node claims plus memory revisions are transactional
  across processes.
- Delivery recovery can requeue stale `sending` records and cancel only the
  selected run/thread/workspace/project scope.
- Agent runs are recorded in the durable run ledger with status, timeline
  events, and cancel requests.
- Client attachments are copied into content-addressed paths isolated by
  workspace, project, thread, and message before a run is queued. Generic
  clients cannot inject host paths. Codex and Claude can declare output files;
  OpenTag validates and copies them into a managed artifact root, records them
  in the run timeline, sends them through Lark or Telegram, and exposes
  authenticated Activity downloads with hash verification.
- Authorized follow-ups in one active thread enter an atomic SQLite steering
  mailbox instead of starting concurrent runs. Live-capable executors can claim
  them in-place. Claude consumes follow-ups through its active stream; Codex
  resumes the same provider session in the next durable turn.
- Every run also loads a bounded, provenance-preserving transcript from the run
  ledger. It bootstraps new provider sessions and remains the continuity fallback
  when provider-local session state is unavailable.
- `/stop`, `/cancel`, `stop`, and `停止任务` in an authorized thread cancel only
  that thread's active run and queued follow-ups. A durable poll carries control
  requests to an independently running worker process.
- Agent execution can be enqueued into a durable run queue and claimed by an
  inline worker, with stale run recovery on startup and through the admin API.
- Agent execution can also be claimed by the standalone `apps/worker` process
  against the same `OPENTAG_DATA_DIR`.
- Routine staging, claiming, and run reconciliation can stay inline or run in
  the standalone `apps/scheduler` process against the same SQLite database.
- Workspace and project routines support interval or IANA-time-zone daily
  schedules, client-neutral destinations, manual triggers, deterministic run
  bridging, deduplication, and stale execution reclaim. Routine work enters the
  same run queue, executor policy, memory scopes, and delivery path as messages.
- Project workflows support saved DAG definitions, manual or typed event
  triggers, event-id deduplication, immutable version snapshots, atomic node
  claims, stale reclaim, and failure propagation. Every node enters the same
  durable agent run queue; intermediate nodes stay internal and sink nodes
  publish to the configured Lark, Telegram, or future client destination.
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
  `forget project ...`. The API and console expose revision history and restore;
  restoring creates a new revision instead of rewriting audit history.
- Client memory writes follow the scope boundary: authorized project users can
  update project/thread memory, identified non-guest workspace members can
  update workspace memory, and global memory is reserved for an installation
  operator through the authenticated control plane.
- The admin console exposes Overview, Projects, Access, Connectors, Routines,
  Workflows, Activity, and Memory workspaces, with workspace identity linking, project
  roles, project policy editing, self-service chat pairing, channel unbinding,
  scheduler/coordinator controls, routine and per-node workflow execution history, run timelines, delivery
  ledgers, and a project-aware client preview.
- Operator authentication is opt-in for local development and required for a
  shared deployment. It maps one or more tokens to named, workspace-scoped
  principals for both Bearer automation and signed, expiring HttpOnly browser
  sessions. Viewer principals are read-only, mutations use the authenticated
  principal for audit, and browser writes retain CSRF protection.

## MVP

1. Lark bot installation and event ingestion.
2. Topic/group binding to an OpenTag thread.
3. Workspace/project/thread routing for one global workspace bot.
4. Live checklist/progress card.
5. Thread-level agent identity and access bundle.
6. Durable outbound delivery, retry, scoped cancel, and stale recovery.
7. GitHub draft PR loop.
8. Supervised worker/scheduler deployment and full run resume.

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

To split scheduling from HTTP ingestion as well, set the server to external
mode and start the scheduler beside the worker:

```bash
OPENTAG_AGENT_WORKER=manual OPENTAG_ROUTINE_SCHEDULER=external OPENTAG_WORKFLOW_COORDINATOR=external npm run dev
npm run scheduler
npm run worker
```

Set `OPENTAG_SCHEDULER_ONCE=1` for a one-shot scheduler smoke test. External
scheduling requires the shared SQLite store.

## Storage

SQLite WAL is the default for delivery, run, inbound-event, channel-binding,
pairing, workspace-access, versioned memory, routine, and workflow state:

```bash
OPENTAG_STORAGE_DRIVER=sqlite
OPENTAG_SQLITE_PATH=./data/opentag.sqlite
OPENTAG_SQLITE_BUSY_TIMEOUT_MS=5000
```

The HTTP server, scheduler, and standalone workers can safely share this
database. Outbox, run, routine, and workflow-node claims use immediate write transactions, and
consuming a pairing code plus creating its channel binding commits atomically.
Run creation and steering arbitration use the same transaction, so competing
Lark, Telegram, or adapter events cannot create parallel work for one thread.
Memory writes also use an immediate transaction, so independent processes
cannot overwrite one another's revisions. On first startup, OpenTag imports
existing `delivery-state.json`, `pairing-state.json`,
`workspace-access.json`, `routine-state.json`, `workflow-state.json`, and scoped
memory Markdown or `memory-state.json` when their SQLite documents do not yet exist. Later
restarts use only the database.

## Thread Steering

The first authorized message creates a run. While that thread has a queued or
running run, later messages are recorded as follow-ups against it. Executors
advertise one of two modes:

- `live`: the executor claims follow-ups through `AgentSteeringChannel` and
  acknowledges them after incorporating the input.
- `next_turn`: OpenTag creates a deterministic continuation only after the
  current run reaches a terminal state.

The inbox, claim, acknowledgement, continuation link, actor, and original
inbound event remain in the run timeline. Operators can inspect or add a
follow-up in **Activity**, call `POST /v1/runs/:id/steer`, or request scoped
cancellation with `POST /v1/runs/:id/cancel`. Tune cross-process control latency
with `OPENTAG_RUN_CONTROL_POLL_MS` (default `250`).

Set `OPENTAG_STORAGE_DRIVER=file` only for legacy or isolated local operation.
Project policy is still file-backed and remains on the production-storage
roadmap. File-mode memory, routines, and workflows keep the same behavior contracts, but
are intended for one process rather than shared workers or schedulers.

## Operator Authentication

Local loopback development remains open when no operator credentials are set.
For a single installation owner, the original random token remains supported:

```bash
export OPENTAG_ADMIN_TOKEN="$(openssl rand -hex 32)"
export OPENTAG_ADMIN_PRINCIPAL_NAME="Platform operations"
export OPENTAG_ADMIN_SESSION_TTL_SECONDS=28800
export OPENTAG_ADMIN_COOKIE_SECURE=true
npm run dev
```

`OPENTAG_ADMIN_TOKEN` is backward-compatible installation-owner access. Scope it
with `OPENTAG_ADMIN_WORKSPACE_IDS=workspace-a,workspace-b` when it should not
control the whole installation. For multiple named credentials, configure a
JSON array and a stable session-signing secret:

```bash
export OPENTAG_OPERATOR_SESSION_SECRET="$(openssl rand -hex 32)"
export OPENTAG_OPERATOR_PRINCIPALS_JSON='[
  {
    "id": "workspace-admin",
    "displayName": "Workspace admin",
    "role": "admin",
    "workspaceIds": ["dev-workspace"],
    "token": "replace-with-at-least-24-random-characters"
  },
  {
    "id": "audit-viewer",
    "displayName": "Audit viewer",
    "role": "viewer",
    "workspaceIds": ["dev-workspace"],
    "token": "replace-with-another-random-credential"
  }
]'
```

`owner` and `admin` can mutate resources inside their workspace scope; `viewer`
is read-only. A `workspaceIds` entry of `"*"` grants installation scope and is
required for global memory plus cross-workspace worker and scheduler controls.
Collection APIs are filtered before limiting results, and object actions verify
the target run, binding, routine, invitation, or delivery belongs to an allowed
workspace.

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

## Workspace Access

Open **Access** to link a member to one or more stable client identities and
assign workspace and project roles. Each project has one access mode:

- `open`: preserves the original behavior and accepts any actor that reaches the
  configured route.
- `workspace`: requires an active workspace member.
- `members`: requires a project membership, while workspace owners and admins
  retain administrative access across projects.

Project managers can invoke the agent, write scoped memory, and manage standing
work. Contributors can invoke the agent and write memory. Viewers cannot start
agent work. Workspace guests can invoke the agent in `workspace` mode but cannot
write memory or manage routines. Authorization denials are recorded in the
inbound ledger, and native clients receive a rate-limited access notice.
Project-level write access covers project and thread memory. Workspace memory
also requires an identified active `owner`, `admin`, or `member`; global memory
cannot be mutated from a client thread, including by a workspace owner.

Workspace member roles govern people invoking OpenTag from client threads;
operator principals govern the separate control plane. Deployment credentials
are currently configured through environment variables. Self-service token
rotation and SSO/OIDC remain later control-plane work.

## Routines

Routines and execution history live in the shared SQLite WAL store by default.
The server scheduler is inline by default, stages due work without catch-up
floods, and bridges each execution into a deterministic agent run. Configure it
with:

```bash
OPENTAG_ROUTINES_ENABLED=true
OPENTAG_ROUTINE_SCHEDULER=inline
OPENTAG_ROUTINE_TICK_INTERVAL_MS=30000
OPENTAG_ROUTINE_CLAIM_STALE_MS=120000
OPENTAG_ROUTINE_BATCH_SIZE=100
OPENTAG_DEFAULT_TIME_ZONE=Asia/Shanghai
```

Use `OPENTAG_ROUTINE_SCHEDULER=external` on the HTTP server and run
`npm run scheduler` for an independently supervised scheduler. Use `manual`
when only explicit `POST /v1/routines/tick` calls should advance work. SQLite
claims are atomic across competing schedulers, while the deterministic
`routine:<executionId>` run ID makes a stale reclaim idempotent if a scheduler
stops between claim and enqueue.

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

## Workflows

Workflows turn manual requests or typed external events into durable agent DAGs.
The common console editor creates a sequential collect/analyze/publish flow;
the API accepts a full acyclic graph of up to 20 agent nodes. Each execution
keeps an immutable copy of the workflow version it started with.

```bash
OPENTAG_WORKFLOWS_ENABLED=true
OPENTAG_WORKFLOW_COORDINATOR=inline
OPENTAG_WORKFLOW_TICK_INTERVAL_MS=2000
OPENTAG_WORKFLOW_CLAIM_STALE_MS=120000
OPENTAG_WORKFLOW_BATCH_SIZE=20
OPENTAG_WORKFLOW_INGRESS_TOKEN=replace-with-a-random-secret
OPENTAG_WORKFLOW_INGRESS_ACTOR=workflow-ingress
```

Use `OPENTAG_WORKFLOW_COORDINATOR=external` with `npm run scheduler` when the
HTTP process should only ingest and stage work. The shared scheduler polls
workflows at their shorter interval without increasing routine staging writes.
`manual` advances only through `POST /v1/workflows/tick`.

An event-triggered workflow matches an exact workspace, project, and event type.
Producers must provide a stable event ID, which is deduplicated across retries:

```bash
curl -X POST 'http://127.0.0.1:3077/v1/workflow-events' \
  -H 'Authorization: Bearer replace-with-a-random-secret' \
  -H 'content-type: application/json' \
  -d '{
    "workspaceId": "dev-workspace",
    "projectId": "opentag",
    "eventType": "issue.ready",
    "eventId": "issue-42-ready-v1",
    "payload": { "issue": 42, "priority": "high" }
  }'
```

Local loopback development permits workflow events when operator auth is off.
Shared deployments require `OPENTAG_WORKFLOW_INGRESS_TOKEN`; if operator auth is
configured without it, the event endpoint is disabled. Workflow nodes are agent
instructions, not arbitrary in-process JavaScript or shell hooks. Audit actor
identity comes from `OPENTAG_WORKFLOW_INGRESS_ACTOR`, never from the event body.

## Local CLI Executors

Real Codex or Claude execution is opt-in. Both CLIs must already be installed and
authenticated for the service account running OpenTag:

```bash
OPENTAG_EXECUTOR_MODE=local-cli
OPENTAG_EXECUTOR_WORKSPACE_ROOT=/srv/opentag/workspaces
OPENTAG_EXECUTOR_TIMEOUT_MS=1200000
OPENTAG_ARTIFACT_ROOT=/srv/opentag/data/artifacts
OPENTAG_MAX_ARTIFACT_BYTES=31457280
OPENTAG_MAX_ARTIFACTS=10
OPENTAG_EXECUTOR_SESSION_MODE=provider
OPENTAG_THREAD_CONTEXT_MAX_ENTRIES=40
OPENTAG_THREAD_CONTEXT_MAX_CHARS=40000
```

OpenTag uses `<workspace root>/<project id>` when that directory exists, falling
back to the configured root. Only a `shell` grant enables workspace writes;
GitHub access is brokered and does not implicitly expose Bash, SSH, `gh`, or a
GitHub token. The process runner
kills the full child process group on cancellation or timeout, bounds retained
stdout/stderr, and filters service secrets such as Lark credentials from the CLI
environment. Additional variables must be named explicitly through
`OPENTAG_EXECUTOR_INHERIT_ENV`.

The executor ignores inherited MCP configuration and injects one per-run
`opentag` stdio proxy. Project policies must list allowed GitHub repositories,
Lark document IDs, and Base app tokens. An empty resource allowlist denies the
call even when the provider grant is enabled. Agents can read all four memory
scopes by default, while autonomous writes are limited to project and thread
memory; workspace/global promotion stays on the authenticated control plane.
GitHub issue/comment, Lark document append, and Base record create/update tools
also require the project's explicit write toggle. No delete, close, merge, or
other destructive brokered operation is currently exposed.

```bash
OPENTAG_GITHUB_TOKEN=github_pat_...
OPENTAG_TOOL_MAX_CALLS_PER_RUN=100
OPENTAG_TOOL_CALL_TIMEOUT_MS=30000
```

When a CLI creates a user-facing file, the executor asks it to declare the
project-relative path in its final response. OpenTag strips that declaration,
rejects traversal and symlink escapes, limits count and size, copies the bytes
to `OPENTAG_ARTIFACT_ROOT`, and emits a durable artifact event. Server and
standalone worker processes must use the same artifact root (the default is
`<OPENTAG_DATA_DIR>/artifacts`). Activity never turns an arbitrary host path
into a download; it serves only managed, hash-matching artifacts to an
authorized operator.

Provider session continuity is enabled by default. OpenTag records the Codex
thread id or Claude session id against the platform/workspace/project/thread and
resumes it on the next run. Claude uses `stream-json` input and advertises
`live`; Codex advertises `next_turn` and resumes the same session after the
current bounded process exits. If a recorded provider session is missing,
OpenTag invalidates it and retries once using the durable thread transcript.
Set `OPENTAG_EXECUTOR_SESSION_MODE=transcript` to disable provider persistence.

The default session namespace includes the host name and service UID because
CLI session files are local to that service account. Set
`OPENTAG_EXECUTOR_SESSION_NAMESPACE` explicitly only when workers share the same
provider session storage. Activity shows the loaded transcript window, provider
session status, and steering mode for each run.

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
      "actor": { "id": "user-1", "displayName": "Ada" },
      "attachments": [{
        "id": "attachment-1",
        "kind": "file",
        "name": "notes.txt",
        "mimeType": "text/plain",
        "contentBase64": "bm90ZXMgZm9yIHRoZSBydW4K"
      }]
    }
  }'
```

Public generic clients require `mentionsAgent: true`, an `/opentag` or
`@opentag` trigger, or an already established thread with `rootMessageId` or
`topicId`. Chat-only events do not silently turn a whole group into an active
session.

Binary generic-client attachments use `contentBase64`; `localPath` is rejected.
HTTP(S) URLs can remain remote references. `OPENTAG_MAX_ATTACHMENT_BYTES`
defaults to 30 MB and is checked before decoded bytes are written.

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

Pairing invitations and bindings share the SQLite control database. Invitation
consumption and configured channel creation are one transaction, so two server
replicas cannot consume the same code into different projects.

## Lark Delivery Mode

Local development defaults to `OPENTAG_LARK_TRANSPORT=memory`, which records
messages, cards, and files in the admin preview without calling Lark. To send
through a real app bot:

```bash
OPENTAG_LARK_TRANSPORT=http
OPENTAG_LARK_DOMAIN=feishu
OPENTAG_LARK_APP_ID=cli_xxx
OPENTAG_LARK_APP_SECRET=xxx
```

Use `OPENTAG_LARK_DOMAIN=lark` for `open.larksuite.com`, or
`OPENTAG_LARK_BASE_URL=https://...` for a custom OpenAPI host.
HTTP mode downloads resources from incoming file/image/audio/video messages
before enqueueing work. Managed image artifacts use Lark image messages when
the format and 10 MB image limit permit it; other artifacts use the 30 MB file
upload path. The app must have the corresponding message and file/image
resource permissions enabled.

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

Incoming Telegram file IDs are resolved with `getFile`, downloaded through the
Bot API, bounded, and copied into the same managed content store before work is
queued. Local managed artifacts are uploaded with `sendDocument`.
