# MaxTag

MaxTag is a workspace Agent runtime for Feishu/Lark. One visible bot serves
many projects and group topics while preserving project policy, scoped memory,
durable execution, human control, and audit evidence.

The current product target is direct: **rebuild Claude Tag's shared Slack
experience for Lark**. The runtime remains client-neutral so Telegram or other
clients can be added later, but Lark is the only primary chat product in this
milestone. Existing Slack code is a compatibility adapter and has no feature
roadmap.

> **Stage: Lark MVP / live pilot.** Real MaxTag long-connection ingress, Codex
> execution, progress cards, same-topic follow-up steering, Stop, Take over,
> source retrieval, tracked delivery, and organization audit have passed live
> smoke tests. MaxTag is not yet production-parity or generally available.

Compatibility note: internal package scopes (`@opentag/*`), environment
variables (`OPENTAG_*`), service filenames, database paths, and metric names
remain stable in this release. They are implementation identifiers, not the
product name, and will only move through an explicit migration.

## Product Boundary

- One workspace Agent identity can serve many Lark groups and projects.
- Route identity is `workspace -> project -> channel -> thread`.
- Memory is independently governed at installation, workspace, project,
  channel, and thread scope; installation memory never enters a project run
  implicitly.
- Workspace identity, Skills, Agents, Sources, tools, network policy, and spend
  defaults flow downward; projects and channels can add or explicitly override
  only the policy dimensions that allow it.
- Agent work stays visible and steerable inside Lark through progress cards,
  follow-ups, Stop, Take over, approvals, artifacts, and durable audit.
- Telegram, GitHub comments, Web Assistant, and generic client ingress exercise
  the same core contracts, but are not parity targets for this phase.

## Why This Repo

HappyClaw / AgentDock is a strong self-hosted agent workbench: multi-runner,
memory, IM routing, durable outbox, and long-running task mechanics. MaxTag keeps
those lessons, but starts from a different product model:

- MaxTag is organized around shared work threads, not a single local operator.
- A workspace-level bot can route many clients into separate projects and
  threads.
- Workspace identity, tools, and network defaults flow into every project;
  projects can explicitly override them without creating a second bot.
- Every routed thread receives policy-granted memory and a client-native
  progress surface.
- Agent work should be visible, steerable, and auditable inside the collaboration
  channel.

## Architecture

```mermaid
flowchart LR
  L["Lark group, topic, or DM"] --> B["Long-connection bridge"]
  B --> S["Server: ingress, routing, API"]
  A["Admin console"] --> S
  S --> P["Policy and access resolution"]
  P --> Q[("SQLite WAL control plane")]
  W["Worker"] <--> Q
  R["Scheduler"] <--> Q
  W --> E["Codex or Claude executor"]
  E --> T["Run-scoped MCP tool broker"]
  T --> K["Memory, Skills, Agents, Sources"]
  T --> X["Approved external tools"]
  W --> O["Transactional outbox"]
  O --> D["Lark cards, replies, files"]
  D --> L
  S --> M["Health, metrics, audit"]
  B --> M
  W --> M
  R --> M
```

### Runtime Processes

| Process | Responsibility | Scaling boundary |
| --- | --- | --- |
| `apps/server` | HTTP APIs, client ingress, route/access resolution, operator console, optional inline workers | Stateless request path plus shared durable stores |
| `scripts/lark-long-connection-bridge.mjs` | Supervised Lark message/card consumers, silent disconnect backfill, forwarding into client ingress | One active consumer set per Lark app installation |
| `apps/worker` | Claim runs, execute Codex/Claude, heartbeat leases, consume steering, publish through outbox | Multiple owner-fenced workers against one store |
| `apps/scheduler` | Claim routines, workflow nodes, Source refresh, delegated Agent tasks, and recovery work | Multiple owner-fenced schedulers against one store |
| `apps/admin` | Dense operator UI for projects, access, activity, memory, Sources, Agents, Skills, spend, audit, routines, and workflows | Served by the server; no separate data authority |

### Control And Data Planes

| Layer | Main modules | Contract |
| --- | --- | --- |
| Client adapters | `platform-lark`, `platform-telegram`, `platform-github`, `platform-slack` | Normalize external events into `SourceThread + SourceMessage`; Lark is primary |
| Routing and policy | `core`, `config` | Resolve workspace/project/channel/thread, actor capability, Agent identity, and inherited access |
| Durable state | `delivery`, `storage-sqlite` | Runs, steering, sessions, outbox, receipts, inbound dedupe, approvals, usage, and audit use SQLite WAL transactions |
| Execution | `runtime-host`, `executor-cli`, `executor-codex`, `executor-claude` | Cancellable, resumable, owner-fenced provider turns with bounded transcript recovery |
| Governed capabilities | `tool-broker`, `memory`, `config` catalogs | Run-scoped tools, exact-write approvals, scoped memory, Skills, delegated Agents, and Knowledge Sources |
| Automation | `routines`, `workflows`, runtime coordinators | Scheduled and event-driven work enters the same route, policy, run, and delivery pipeline |
| Collaboration UI | `ui-cards`, tracked transports, `apps/admin` | Lark progress/approvals plus operator activity, spend, access, and organization audit |

### Message Lifecycle

1. The Lark bridge receives a message and preserves both the root message and
   Lark topic-container IDs. Root and replies canonicalize to one MaxTag
   thread.
2. The server resolves the configured workspace/project route and current
   member capability before creating work.
3. Policy resolution loads the workspace baseline plus project/channel
   overlays, memory grants, Skills, Agents, Sources, executor, budget, and
   network limits.
4. SQLite atomically creates a run or appends authorized same-thread steering
   to the active run.
5. A worker claims the run with a renewable owner-fenced lease, starts or
   resumes the provider session, and exposes only the run's brokered tools.
6. Progress and tool evidence update one receipt-tracked Lark card. Follow-ups
   steer the active turn or become a durable continuation.
7. Stop, Take over, and approvals bind the actor and action to the exact card
   receipt, route, and run. A takeover cancels pending work, records the human,
   updates the terminal card, and posts a handoff in the original topic.
8. Results and artifacts leave through the transactional outbox; activity,
   usage, and organization audit remain queryable after delivery.

## Monorepo Layout

```text
apps/server                 HTTP/event ingestion and runtime host
apps/admin                  Operator console for projects, access, connectors, routines, workflows, runs, and memory
packages/core               Platform-neutral domain model and runtime contract
packages/config             Agent policy, workspace identities, project roles, and audit
packages/platform-lark      Feishu/Lark adapter
packages/platform-telegram  Telegram webhook and Bot API adapter
packages/platform-github    GitHub issue and PR comment adapter
packages/platform-slack     Compatibility-only Slack adapter
packages/executor-cli       Bounded, cancellable local CLI process runtime
packages/executor-codex     Codex dry-run and local CLI executor
packages/executor-claude    Claude dry-run and local CLI executor
packages/runtime-host       Shared runtime host for independent workers
packages/tool-broker        Per-run MCP capabilities, provider isolation, and tool audit
packages/tools-github       GitHub artifact and grant contracts
packages/memory             Global/workspace/project/channel/thread memory stores
packages/routines           Scheduled work, execution claims, and audit history
packages/workflows          Durable DAG definitions, event triggers, node claims, and execution history
packages/delivery           Durable outbox, delivery tracking, bindings
packages/storage-sqlite     WAL storage, migration, and atomic control transactions
packages/ui-cards           Progress/checklist card models
```

## Capability Evidence

MaxTag distinguishes code from evidence. `Implemented locally` means tests
exercise the behavior; `Live proven` means a real MaxTag event traversed Lark,
the provider runtime, durable state, and Lark delivery.

| Capability | Current evidence | Maturity |
| --- | --- | --- |
| Workspace/project route and private group identity | A configured workspace/project route persisted across a real private MaxTag group topic | Live proven |
| Topic continuity | A root event without `thread_id` and a later `omt + root_id` reply canonicalized to one thread after the 2026-08-13 fix | Live proven |
| Real-time follow-up | An authorized same-topic follow-up reached the active Codex turn as `steering_applied` | Live proven |
| Human Take over | A live run was receipt-bound, actor-authorized, cancelled, terminally updated, handed off in the same topic, and organization-audited | Live proven; reproduce with `npm run smoke:lark-takeover` |
| Stop | Exact-card cancellation and idempotent repeated callback reached terminal `cancelled` | Live proven; reproduce with `npm run smoke:lark-stop` |
| Knowledge Source search/read | Exact route-bound phrase retrieval, source/line citation, delivery, and disable fencing | Live proven; raw event ledgers stay outside the public repository |
| In-thread capability status | A real private-group `/status` resolved the current workspace/project/channel/topic and actor access, completed through the dedicated `thread-status` executor, delivered one reply to the same topic, recorded a redacted organization audit entry, and created no model usage record | Live proven |
| Runtime SIGTERM recovery | Lease heartbeat, requeue, replacement claim, progress-card reuse, and publish fencing | Local process proven; production supervisor proof pending |
| Proactive routines | Scheduler visibility, routing, failure policy, and preflight | Implemented locally; real scheduled Lark send pending |
| Disconnect recovery | Per-channel checkpoints and idempotent silent backfill | Implemented locally; blocked by Lark history scopes in the pilot app |

## Gap To The Goal

The goal is not “all boxes have code.” It is a production Lark workspace bot
that feels as controllable and dependable as Claude Tag, while retaining the
deeper AgentDock-style runtime underneath. The following list is the current
acceptance backlog.

### P0: Launch Evidence

| Gap | Current state | Done when |
| --- | --- | --- |
| Disconnect compensation | Backfill is implemented, but the pilot app returns Lark `230027` without message-history scopes | Stop the bridge, send one message, restart, and prove exactly one run and one reply with no recovery chatter |
| Inbound resources | Download/storage paths and policy tests pass | A real MaxTag file and image enter managed storage, reach the executor, and produce tracked artifacts |
| Long-topic recovery | Provider session resume, compaction, overflow recovery, and transcript fallback pass locally | One long MaxTag topic crosses compaction/restart and continues without replaying or losing user intent |
| Proactive work | Routines/workflows and quiet/failure policy are implemented | A real scheduled MaxTag task executes, delivers, retries on failure, and emits one recovery notice |
| Spend enforcement | Stacked budgets and 75%/95% alerts pass locally | Real Lark work is denied over limit and threshold alerts are delivered exactly once |
| Production supervision | systemd units, metrics, leases, and local replacement smoke exist | Kill worker/server/bridge under the deployed supervisor and prove route, claim, and delivery recovery |
| Multi-project isolation | One MaxTag pilot route is live | A second real Lark project proves route, memory, Source, tool, spend, and audit isolation |

### P1: Product Completeness

- Prove route-scoped Skills and both synchronous/asynchronous delegated Agents
  in real Lark, including the main-Agent continuation after async completion.
- Prove remote Knowledge Source refresh and revision fencing against a changing
  source, not only local ingestion and MaxTag read.
- Add SSO/OIDC or directory synchronization and hosted account recovery on top
  of persistent owner/admin/viewer credentials.
- Complete export and deletion policy for inbound events, usage, source
  transcripts, memory, managed artifacts, and audit retention.
- Add process/container destination telemetry and enforced egress boundaries;
  current broker audit is not universal network-call observation.
- Make provider sessions, connector/MCP configuration, and state propagation
  reliable across multiple hosts.
- Expand Lark-native event Sources beyond Docx to Sheets, Base, Drive, and
  broader channel activity where product demand justifies it.
- Improve workflow authoring for branches/parallel paths without turning the
  console into a generic automation product. Per-workflow queue health is now
  implemented locally in the workflow snapshot and operator list.

### P2: Scale And Depth

- Instruction-level resumable checkpoints when a provider turn itself cannot
  be resumed.
- Hosted interactive reports. First-class PR/link artifact declarations are
  implemented locally with public-HTTPS validation, durable run evidence, and
  client-native link delivery; hosted report rendering remains.
- GitHub App installation-token exchange is implemented locally for comment
  delivery and brokered tools, with short-lived cached tokens and automatic
  refresh. Live App installation proof remains.
- Embedding/ANN retrieval when authorized corpora outgrow bounded lexical and
  semantic-alias recall.
- High-capacity normalized storage, backup/restore, and disaster-recovery
  procedures for hosted deployments.

Slack feature work is deliberately absent from this backlog. The existing
adapter remains under compatibility regression tests only. Telegram and future
clients may reuse the core after Lark parity, but they do not block this goal.

For the detailed evidence matrix and sequencing, see
[`docs/claude-tag-parity.md`](docs/claude-tag-parity.md),
[`docs/agentdock-parity.md`](docs/agentdock-parity.md), and
[`docs/roadmap.md`](docs/roadmap.md).

## Current Capability

- Lark event ingestion, file/image/audio/video resource download, live progress
  cards, text replies, and native file/image upload are wired behind selectable
  memory/http transports. Active cards expose receipt-bound Stop and Take over
  actions; Take over records the Lark member and leaves a handoff in the source
  topic, while terminal cards remove both controls.
- Telegram has native Bot API webhook ingestion, secret validation, update
  idempotency, chat/forum-topic normalization, editable progress messages,
  long-message chunking, topic replies, managed inbound downloads, outgoing
  files, and memory/http transports.
- GitHub has native `issue_comment` webhook ingestion for issues and pull
  requests, HMAC-SHA256 validation, repository/issue normalization, editable
  progress comments, chunked final replies, self-loop suppression, tracked
  delivery, and memory/http transports.
- The core model is client-neutral: Lark, Telegram, Slack, and GitHub comments
  are clients of the same runtime contract.
- Authorized members can ask `/status`, `/maxtag status`, `what can you access?`,
  or `你能访问什么？` in a topic. The zero-model reply is route-scoped, omits
  disabled and sibling-project resources, remains available after a monthly
  budget is exhausted, and does not consume a model run.
- Other clients can enter through `/v1/client/events`, which normalizes a
  client envelope into the same run queue, scoped memory, and delivery ledger.
  Deployments can protect this adapter-only ingress with its own Bearer token.
- Memory is stored in installation, workspace, project, channel, and thread documents. In
  the default SQLite mode, every remember, forget, restore, and legacy import
  creates an immutable revision with its trusted operator or client actor.
- Workspace, project, and channel agent policies are persisted separately from memory,
  including a workspace identity/executor/tool/network baseline and explicit
  per-project identity, capability, and memory modes plus channel instruction,
  tool, network, budget, and memory-approval overlays with an admin change audit.
- Reusable Skills form an installation-managed Markdown procedure catalog.
  Workspace Skills are the baseline for every route; projects and channels can
  add their own Skill IDs without removing the workspace baseline. Executors
  receive only enabled Skill names and descriptions, then use the read-only
  `skills_list` and `skills_load` broker tools to load a selected procedure on
  demand. Skill text cannot grant tools, credentials, network access, or broader
  data access. Installation operators manage catalog content and enablement;
  workspace operators assign existing Skills without receiving their bodies.
- Governed delegated Agents form an installation-managed specialist catalog.
  Workspace, project, and channel policies add Agent IDs to the exact route.
  The parent sees enabled summaries and may invoke one focused child task with
  `agents_list` and `agent_invoke`. The child gets no conversation transcript or
  provider session, cannot delegate or publish directly, and receives only the
  definition-selected intersection of the parent's read grants, Skill IDs,
  memory scopes, and network hosts. Definitions bind an executor and optional
  low-cost model such as Luna, with bounded turns, timeout, separate usage, and
  organization audit evidence. Installation operators manage definitions;
  workspace operators only assign catalog entries.
- The parent can also propose durable asynchronous work with
  `agent_task_create`, inspect it with `agent_tasks_list`, and stop it with
  `agent_task_cancel`. Create and cancel always require an exact-argument
  approval. The shared Server/Worker task ledger atomically claims work,
  rechecks the current route, Agent revision, enablement, and approved access
  ceiling, supports cross-process cancellation, and schedules one deterministic
  main-Agent continuation back into the original thread after completion.
  Task bodies and results reject credential-like values; child Agents remain
  read-only and cannot recurse, publish, write memory, or share transcripts.
- Every delegated invocation has an independent audit identity. Activity and
  Web Assistant group its lifecycle, bounded task/result preview, usage, and
  child tools into one nested trace, so repeated calls to the same Agent do not
  merge. The Assistant projection omits definition bodies, full arguments,
  results, internal paths, and provider-private fields.
- Workspace members link stable client identities such as Lark `open_id`,
  Telegram user IDs, or GitHub logins to workspace roles. Projects can stay open, require any
  active workspace member, or require an explicit project role. Client ingress
  checks separate capabilities for agent invocation, memory writes, and routine
  management before a run is queued.
- Executors are selected per project through a shared descriptor registry.
  Built-in Codex and Claude registrations support safe-by-default dry-runs or
  explicit local CLI execution, and the standalone worker resolves the same
  registry, policy, and runtime mode as the HTTP server. The workspace API and
  Projects console expose each runner's session, steering, tool, attachment,
  artifact, memory-candidate, and context-recovery capabilities; an unavailable
  configured runner fails closed instead of silently falling back.
- Local Codex and Claude runs receive a short-lived MCP endpoint containing only
  the current run's grants. The broker validates every input schema, enforces
  resource allowlists and call/time/result limits, and records durable call and
  result events. It provides scoped memory, approved GitHub repository and issue
  reads plus issue/comment writes, approved Lark document read/append, and Base
  record query/create/update. External writes require both an explicit project
  write grant and, by default, a one-time exact-argument approval in Lark or the
  Activity console. GitHub and Lark credentials stay in the host process.
- Delivery, run, inbound-event, binding, pairing, workspace-access, memory,
  routine, and workflow state defaults to a shared SQLite WAL database. Outbox,
  run, routine, and workflow-node claims plus memory revisions are transactional
  across processes.
- Delivery recovery can requeue stale `sending` records and cancel only the
  selected run/thread/workspace/project scope.
- Agent runs are recorded in the durable run ledger with status, timeline
  events, cancel requests, and invocation-scoped delegated-Agent evidence.
- Client attachments are copied into content-addressed paths isolated by
  workspace, project, thread, and message before a run is queued. Generic
  clients cannot inject host paths. Codex and Claude can declare output files;
  MaxTag validates and copies them into a managed artifact root, records them
  in the run timeline, sends them through Lark or Telegram, and exposes
  authenticated Activity downloads with hash verification. They can also
  declare managed `link` and `pull-request` references. MaxTag accepts only
  credential-free public HTTPS URLs, validates pull-request URL shape, removes
  fragments, and records the normalized reference without fetching it.
- Authorized follow-ups in one active thread enter an atomic SQLite steering
  mailbox instead of starting concurrent runs. Live-capable executors can claim
  them in-place. Claude consumes follow-ups through its active stream; Codex
  uses app-server `turn/steer`. A completion race or rejected steer remains in
  the durable mailbox and resumes the same provider session in the next turn.
- Every run also loads a bounded, provenance-preserving transcript from the run
  ledger. It bootstraps new provider sessions and remains the continuity fallback
  when provider-local session state is unavailable.
- `/stop`, `/cancel`, `stop`, and `停止任务` in an authorized thread cancel only
  that thread's active run and queued follow-ups. A durable poll carries control
  requests to an independently running worker process.
- Lark card actions are tied back to the delivered progress-card receipt before
  cancellation. MaxTag verifies the message ID, chat, workspace, project, and
  run, then applies the same project actor authorization used by text commands.
- Agent execution can be enqueued into a durable run queue and claimed by an
  inline worker, with stale run recovery on startup and through the admin API.
- Agent execution can also be claimed by the standalone `apps/worker` process
  against the same `OPENTAG_DATA_DIR`.
- Server, Lark bridge, worker, and scheduler expose Prometheus text metrics for
  process and loop health, queue depth, oldest status age, run leases, routines,
  workflow nodes, and long-connection consumers. Metrics use a separate Bearer
  token and avoid per-run or per-project labels. Standalone observability
  listeners stay disabled unless their loopback ports are configured.
- Agent workers heartbeat an owner-fenced durable lease. SIGTERM stops new
  claims, terminates the local executor, returns interrupted work to `queued`,
  and lets a replacement worker reuse the same native progress card or comment.
  A final lease check prevents an old worker from publishing after takeover.
- Routine staging, claiming, and run reconciliation can stay inline or run in
  the standalone `apps/scheduler` process against the same SQLite database.
- Workspace and project routines support interval or IANA-time-zone daily
  schedules, client-neutral destinations, manual triggers, deterministic run
  bridging, deduplication, and stale execution reclaim. Routine work enters the
  same run queue, executor policy, memory scopes, and delivery path as messages.
  Each routine can publish every result, stay fully silent, or suppress routine
  progress/results until a configurable consecutive-failure threshold. Failure
  incidents alert once, can emit one recovery notice, retry with bounded
  backoff, and are invalidated when the routine route or policy changes.
- Project workflows support saved DAG definitions, manual or typed event
  triggers, event-id deduplication, immutable version snapshots, atomic node
  claims, stale reclaim, failure propagation, durable execution cancellation,
  and failed-node retry. Every retry creates a new attempt run while preserving
  prior run evidence; intermediate nodes stay internal and sink nodes publish
  only through an explicit same-project Lark, Telegram, GitHub, or future client
  binding.
- Lark and Telegram users can create, list, pause, resume, or delete standing
  work in the current project/topic. Each change is scoped to that conversation
  and records the requesting user for audit.
- Real Lark delivery can be enabled with `OPENTAG_LARK_TRANSPORT=http`,
  `OPENTAG_LARK_APP_ID`, and `OPENTAG_LARK_APP_SECRET`; use
  `OPENTAG_LARK_DOMAIN=lark` for international Lark.
- Lark callbacks support signed AES-256-CBC encrypted delivery, v1/v2
  verification-token checks, replay-window checks, duplicate short-circuiting,
  `card.action.trigger` handling, and processed/ignored states in the inbound
  event ledger.
- A configured Lark group `chat_id` binding maps into a project route; an
  unbound group falls back to the workspace default project. The server reads
  chat metadata to preserve the real group name and private/public boundary, so
  one workspace bot can serve multiple group/project memories without treating
  chat ids as project ids or collapsing them into one global thread.
- Lark topic continuation is supported: a mention can establish a thread binding,
  then later messages in that topic continue without repeating the mention.
- When a Lark mention first activates an existing topic, MaxTag can import the
  prior Lark thread history through the message-list API, store it in a
  platform-neutral source-message ledger, and load it into the next prompt with
  original message-id de-duplication. The import is capped at 50 messages by
  default and logs imported, duplicate, truncated, or permission-failure
  evidence on the run timeline.
- Clients without a native adapter use tracked text receipts in the outbox until
  a real platform transport is wired.
- Channel/project bindings can be configured through the admin API and console,
  including mention-only vs always-on activation.
- Lark and Telegram chats can self-connect to a project with a short-lived,
  single-use `/pair` command generated in the Connectors console. Only a salted
  code hash is persisted. Pairing invitations can optionally restrict which
  platform actor IDs may consume the code; rejected attempts do not consume it.
  Unbinding a chat also clears its observed topic routes.
- Every binding create, update, self-service pairing connection, and unbind
  writes a binding audit record with actor, reason, before/after snapshots, and
  workspace/project filters. Operators can inspect it through
  `/v1/binding-audit`.
- Workspace bindings can be exported through `/v1/binding-export` and imported
  through `/v1/binding-import`. Imports default to dry-run, validate project IDs,
  and only write audited configured bindings when `apply: true` is explicit.
- Scoped memory can be viewed and updated through `/v1/memory`, the admin
  console, or chat commands such as `remember project ...`,
  `remember group ...`, and `forget channel ...`. The API and console expose
  revision history and restore;
  restoring creates a new revision instead of rewriting audit history. Operators
  can export scoped memory documents and bounded revision history through
  `/v1/memory-export`, and inspect line-level revision changes through
  `/v1/memory-diff`. Memory revision compaction is available through
  `/v1/memory-compact`; it dry-runs by default, protects latest and
  restore-referenced revisions, and applies only when `apply: true` is explicit.
  Workspace/project policy can require chat-originated `remember` or `forget`
  commands for selected scopes to become `/v1/memory-proposals` instead of
  immediate writes; operators can approve or reject them before they become
  revisions. Executors can also emit up to three bounded `OPENTAG_MEMORY`
  candidates at the end of a run. MaxTag strips those declarations from the
  visible reply, rejects unauthorized or credential-like values, and always
  queues accepted candidates for approval instead of writing durable memory
  directly. Approved memory can be searched within the current resolved route
  through `/v1/memory-search`, the brokered `memory_search` tool, or the Memory
  console; search never scans another project, channel, or thread implicitly.
  Before each normal agent turn, a separate low-cost runner selects relevant
  references from the already-authorized route snapshot. Host-side candidate
  generation uses weighted Latin tokens, Chinese word segmentation and bounded
  n-grams, small query alias groups, query-coverage scoring, persisted aliases,
  present-state hints, bounded multi-line fact context, and duplicate-fact
  collapse; the runner only reranks those bounded candidates. MaxTag accepts only
  exact current `documentKey` / version / line references and reconstructs the
  original text before giving it to the project agent; forged, stale, or
  low-confidence references are ignored. Approved `remember`, `replace`,
  `merge`, and index-only proposals may attach 2-6 semantic search aliases to an exact
  versioned memory line. The aliases are persisted in SQLite, validated by the
  line content hash, and used only for candidate ranking; the main project agent
  receives the original approved line, never alias text. Unchanged-line aliases
  migrate across later document versions, while replaced or forgotten lines
  invalidate automatically. Pending/rejected proposals never affect retrieval.
  The selector has no tools or provider
  session, times out after 15 seconds by default, and degrades to bounded local
  indexed/lexical/recent retrieval without blocking the reply. This is a
  version-bound semantic alias index plus model reranking, not an embedding/ANN
  vector database.
  Operators can also attach an explicit per-fact expiry when remembering a note,
  or set, change, and clear expiry later by matching that note through
  `/v1/memory-expiry` or the Memory console. Expiry metadata is bound to the
  current document version, original line number, and line hash. It migrates
  only with unchanged lines, covers complete multi-line notes, and is audited.
  Expired facts are omitted from runtime context, lexical search, and semantic
  indexing while immutable revisions retain the original content for review;
  clearing expiry restores the fact without creating a replacement revision.
  Workspaces can also define a default of keep indefinitely or 1-3650 days.
  Projects may inherit that default, keep their local scopes indefinitely, or
  set a different duration. The effective project policy covers project,
  channel, and thread writes, while workspace facts always follow the workspace
  policy. Defaults apply when a direct write commits or when a proposal is
  approved, so pending work receives a full approval-time lifetime and existing
  facts are never rewritten retroactively. The console can explicitly keep one
  new fact indefinitely instead of using its route default.
  For cross-entry synthesis, `/v1/memory-query` runs a separate one-shot,
  read-only Memory Runner. `/v1/memory-analysis` compares the complete bounded
  thread transcript with approved memory and emits `remember`, version-bound
  `replace`, atomic multi-fact `merge`, `forget`, or index-only proposals. A
  merge names every exact source fact, is limited to one scope and one current
  document version, and becomes one immutable revision only after approval.
  The runner has no brokered tools or provider
  session and never writes memory directly. Configure it independently with
  `OPENTAG_MEMORY_EXECUTOR` and `OPENTAG_MEMORY_MODEL`; local CLI mode defaults
  to Codex with `gpt-5.6-luna`. Optional per-purpose retrieval, query, analysis,
  and wrapup model overrides inherit that default when unset, so frequent
  reranking can stay cheap while lower-frequency consolidation can use a more
  capable model. Successful real agent runs also enqueue a
  debounced background wrapup. Its durable per-thread cursor advances only
  after successful analysis; long transcripts continue in oldest-first batches,
  stale claims recover across processes, failures retry with backoff, and
  terminal job history is retained on a bounded schedule. The reply path does
  not wait for this work, and every accepted decision still becomes an approval
  proposal rather than an immediate write. The Memory console presents those
  proposals as an explicit current/proposed comparison with retrieval aliases,
  model rationale, source, target document version, and approval-time retention
  evidence so reviewers do not have to infer a merge from a single summary line.
  Every successful runner invocation records a separate durable usage entry as
  `memory_retrieval`, `memory_query`, `memory_analysis`, or `memory_wrapup`.
  These calls contribute provider-reported tokens and cost without inflating the
  user-run counter; the primary project executor remains the `agent` purpose.
- Workspace Sources support authenticated automation through
  `POST /v1/knowledge/ingest` and content-free status polling through
  `GET /v1/knowledge/ingest/:jobId`. Configure an array of named credentials in
  `OPENTAG_KNOWLEDGE_INGRESS_PRINCIPALS_JSON`; every token is fixed to one
  workspace and request bodies cannot override that boundary. `dedupeKey`
  makes retries idempotent across Server and Worker processes. Each accepted
  source revision queues durable semantic enrichment. A tool-free, session-free
  low-cost runner, defaulting to Codex `gpt-5.6-luna`, proposes bounded line
  ranges, fact-only summaries, multilingual aliases, and confidence. The host
  validates the current revision/hash, line bounds, credentials, and exact
  excerpt hash before publishing the index. Stale jobs cannot overwrite a newer
  revision, and lexical retrieval remains available when enrichment is absent
  or fails. Source text, generated aliases, and passage summaries are never
  returned by the automation status API. Configure the runner independently
  with `OPENTAG_KNOWLEDGE_EXECUTOR`, `OPENTAG_KNOWLEDGE_MODEL`, and the
  `OPENTAG_KNOWLEDGE_ENRICHMENT_*` controls. This is a verified semantic alias
  index, not embedding or ANN retrieval.
- Source file and automation ingest accept UTF-8 text, HTML, PDF, and DOCX.
  Raw inputs are bounded to 10 MB, extracted text remains bounded to 200 KB,
  active HTML is removed, DOCX archive expansion is checked, and only extracted
  text plus provenance enters the revision. URL Sources can queue durable manual
  refreshes or use a governed hourly, six-hour, daily, or weekly schedule. Due
  discovery and enqueue are atomic across Server and Worker processes, and the
  console shows the next refresh time. The Worker permits public HTTPS only, validates DNS and each
  same-origin redirect, uses ETag and Last-Modified, and advances the revision
  only when content changes. Configure the loop with
  `OPENTAG_KNOWLEDGE_REFRESH_*`.
- Client memory follows the resolved workspace, project, channel, and thread
  boundaries. Workspace-shared public channels load all four runtime scopes;
  isolated projects omit workspace memory; private channels can read but not
  write workspace memory; direct messages use thread memory only. Workspace writes also require an
  identified non-guest member. Installation memory stays outside project runs
  and is reserved for an installation operator.
- The admin console exposes Overview, Projects, Skills, Agents, Access, Connectors, Routines,
  Workflows, Activity, and Memory workspaces, with workspace identity linking, project
  roles, project policy editing including memory approval gates, self-service
  chat pairing, channel unbinding,
  scheduler/coordinator controls, routine and per-node workflow execution history, run timelines, delivery
  ledgers, workspace-isolated Activity search across visible route/request/output
  fields, fast scoped memory search, per-turn semantic retrieval status,
  one-shot semantic query, manual transcript synthesis, automatic wrapup
  status, history/restore, pending memory proposal review, recent asynchronous
  Agent tasks with bounded results and Stop controls, and a
  project-aware client preview.
- Operator authentication is opt-in for local development and required for a
  shared deployment. It maps one or more tokens to named, workspace-scoped
  principals for both Bearer automation and signed, expiring HttpOnly browser
  sessions. Viewer principals are read-only, mutations use the authenticated
  principal for audit, and browser writes retain CSRF protection. Installation
  owners can create, rotate, and revoke persistent operator credentials from
  **Access**. Only a token digest is stored, plaintext is returned once, and
  rotation or revocation invalidates both Bearer access and existing sessions.

## MVP

1. Lark bot installation and event ingestion.
2. Topic/group binding to a MaxTag thread.
3. Workspace/project/channel/thread routing for one global workspace bot.
4. Live checklist/progress card.
5. Thread-level agent identity and access bundle.
6. Durable outbound delivery, retry, scoped cancel, and stale recovery.
7. GitHub draft PR loop.
8. Supervised worker/scheduler deployment and restart recovery.

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

## Production Operations

`deploy/systemd` contains a four-process target for the HTTP server, Lark
long-connection bridge, durable worker, and routine/workflow scheduler.
`deploy/prometheus` contains a
Bearer-authenticated scrape fragment plus alerts for dead processes, stale
long-connection consumers, stale loops, stale run leases, queued work, stuck
outbound delivery, and expired scheduler claims. See
[`deploy/README.md`](deploy/README.md) for host paths, service-account setup,
hardening, rollout, and restart smoke steps.

The HTTP server serves `/metrics` on its normal port. Independent processes
enable loopback health and metrics listeners with:

```bash
OPENTAG_METRICS_TOKEN=replace-with-a-random-secret
OPENTAG_OBSERVABILITY_HOST=127.0.0.1
OPENTAG_WORKER_OBSERVABILITY_PORT=3078
OPENTAG_SCHEDULER_OBSERVABILITY_PORT=3079
OPENTAG_LARK_BRIDGE_OBSERVABILITY_PORT=3080
OPENTAG_AGENT_RUN_HEARTBEAT_MS=15000
```

Health endpoints remain unauthenticated for a local supervisor. Metrics require
`Authorization: Bearer $OPENTAG_METRICS_TOKEN`. Restart recovery replays or
resumes a run from durable context; instruction-level execution checkpoints
remain future work.

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
cannot overwrite one another's revisions. On first startup, MaxTag imports
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
- `next_turn`: MaxTag creates a deterministic continuation only after the
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
required for installation memory plus cross-workspace worker and scheduler controls.
Collection APIs are filtered before limiting results, and object actions verify
the target run, binding, routine, invitation, or delivery belongs to an allowed
workspace.

Installation owners can alternatively manage persistent credentials in
**Access** or through `/v1/operator-credentials`. The first persistent
credential on an otherwise open loopback install must be an `owner` scoped to
`"*"`; its create response establishes the browser session before the install
closes anonymous access. Tokens use an `otk_` prefix, are shown only on create
or rotate, and are stored as SHA-256 digests under `OPENTAG_DATA_DIR/config`.
Every lifecycle change is revision-checked and included in Organization Audit;
the last persistent installation owner cannot be revoked when no environment
bootstrap owner exists.

The console exchanges that token for a signed, expiring `HttpOnly` session
cookie. Scripts can send the token directly:

```bash
curl -H "Authorization: Bearer $OPENTAG_ADMIN_TOKEN" \
  http://127.0.0.1:3077/v1/workspace
```

`/health`, static console assets, and native Lark/Telegram callbacks remain
outside the operator session boundary; the native callbacks retain their own
Lark signature/token or Telegram webhook-secret checks. Generic adapters use a
separate `OPENTAG_CLIENT_INGRESS_TOKEN` Bearer credential. When operator
authentication is enabled without that credential, `/v1/client/events` is
disabled instead of accepting anonymous events.

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
also requires an identified active `owner`, `admin`, or `member`; installation memory
cannot be mutated from a client thread, including by a workspace owner.
Workspace, project, and channel policy updates also accept a `budgetPolicy` object with
`mode`, `scope`, `maxRunsPerMonth`, and `maxCostUsdPerMonth`. Workspace and project
aggregate caps stack with one inherited/default/custom channel cap, so a local
override cannot bypass a parent hard limit. Workspace and project policies may
also set `defaultChannelBudgetPolicy` for newly observed channels. Limits are
checked before executor work starts; denied client runs return
`usage_budget_denied`, while completed runs write provider-reported monthly usage
and idempotent 75%/95% alerts. `/v1/spend` and the Spend console expose full-month
workspace/project/channel analytics plus separate `agent`, retrieval, query,
analysis, and wrapup call/token/cost totals. Memory-runner records use zero runs,
so they count toward cost caps without consuming the user-run allowance.
`/v1/spend/policies` patches only budget fields under the existing operator role
and audit boundary.
`/v1/audit`, `/v1/audit.csv`, and the Audit console provide one
workspace-isolated task, brokered-tool, policy, access, binding, routine, and
workflow chronology. Filters cover project, actor, action, category, outcome,
and time. Consolidated evidence intentionally omits reply bodies, tool argument
values, provider sessions, result previews, and executor snapshots. Provider
mutation, command, and web tools are disabled; brokered equivalents are audited
individually, while provider-native Read/Glob/Grep internals remain aggregate
read evidence only.
Channel policies are managed through `/v1/channel-policies` and apply to every
topic in the exact workspace/project/platform/channel route.

Workspace member roles govern people invoking MaxTag from client threads;
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

Use the **Routines** console to create one-time, interval, or daily work, choose
a project and client destination, set Every result / Failures only / Silent
notifications, trigger a manual run, and open the corresponding run timeline.
`POST /v1/routines/tick` is available for an operator or external supervisor.
Local development still uses the configured dry-run executor and memory Lark
transport unless those modes are explicitly changed.

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
for the current project and conversation destination. The list includes each
item's next run and latest execution status, completion time, and bounded result
or error summary. The brokered `routine_list` tool exposes up to 20 items per
call, at most three recent executions per item, and marks truncated instruction
text explicitly. Both execution and notification snapshots must still match the
current topic route; changing a route or notification policy closes pending
incident notices instead of carrying them to another conversation.

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
OPENTAG_LARK_DOCUMENT_WATCHER_ENABLED=true
OPENTAG_LARK_DOCUMENT_WATCHER_TICK_INTERVAL_MS=5000
OPENTAG_LARK_DOCUMENT_WATCHER_CLAIM_STALE_MS=120000
OPENTAG_LARK_DOCUMENT_WATCHER_BATCH_SIZE=5
OPENTAG_WORKFLOW_INGRESS_TOKEN=replace-with-a-random-secret
OPENTAG_WORKFLOW_INGRESS_ACTOR=workflow-ingress
OPENTAG_ALERTMANAGER_INGRESS_TOKEN=replace-with-a-different-random-secret
OPENTAG_ALERTMANAGER_INGRESS_MAX_BYTES=262144
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

GitHub is also a native workflow producer. A signed `/v1/github/events` webhook
for `pull_request`, `issues`, or `workflow_run` resolves the configured
repository binding before it can stage work, then emits one of these project
events using `X-GitHub-Delivery` for durable deduplication:

```text
github.pull_request.<action>
github.issue.<action>
github.workflow_run.<conclusion-or-action>
```

Common CI examples are `github.workflow_run.failure`,
`github.workflow_run.success`, and `github.workflow_run.cancelled`. The
producer passes a bounded, allowlisted snapshot rather than the raw webhook
body. Workflow prompts explicitly treat every event payload as untrusted
evidence. Subscribe only to the event families a project uses; the existing
`OPENTAG_GITHUB_WEBHOOK_SECRET` signature gate and configured `github` channel
binding remain mandatory for native producer events.

Alertmanager is a second native producer. Create an Alertmanager route in the
Workflows console, then configure its receiver with the copied URL and the
dedicated bearer token:

```yaml
receivers:
  - name: opentag
    webhook_configs:
      - url: https://opentag.example/v1/alertmanager/ROUTE_ID/events
        send_resolved: true
        max_alerts: 8
        http_config:
          authorization:
            type: Bearer
            credentials: replace-with-a-different-random-secret
```

The route, not webhook JSON, fixes the target workspace and project. MaxTag
accepts Alertmanager webhook schema version 4, emits
`alertmanager.firing` or `alertmanager.resolved`, and stores only bounded
labels, annotations, timestamps, URLs, fingerprints, and group metadata as
untrusted evidence. An exact normalized alert state is deduplicated across
retries and repeat notifications; a status or evidence change creates a new
event. The receiver is fail-closed when
`OPENTAG_ALERTMANAGER_INGRESS_TOKEN` is absent.

Lark documents can also act as durable project event sources. Create a
`Lark document` source in the Workflows console, choose a project that grants
`lark-docs` read access to that document ID, and select
`lark.document.changed` as the workflow trigger. The first successful read
establishes a revision baseline without firing. Later revisions emit one
deduplicated event with bounded plain-text content; the current project grant
is checked again before every poll.

Operators can stop an active execution or retry one failed node without
replaying completed upstream work:

```text
POST /v1/workflow-executions/:executionId/cancel
POST /v1/workflow-executions/:executionId/nodes/:nodeId/retry
```

Cancellation freezes unfinished nodes and requests cancellation for their
active agent runs and outbox records. Retry resets only the failed node and
descendants skipped because of that failure. Every attempt has a distinct run
ID, late results from older attempts cannot overwrite the current node, and
both operator actions enter the workspace audit ledger.

## Local CLI Executors

Real Codex or Claude execution is opt-in. Both CLIs must already be installed and
authenticated for the service account running MaxTag:

```bash
OPENTAG_EXECUTOR_MODE=local-cli
OPENTAG_EXECUTOR_WORKSPACE_ROOT=/srv/opentag/workspaces
OPENTAG_EXECUTOR_TIMEOUT_MS=1200000
OPENTAG_ARTIFACT_ROOT=/srv/opentag/data/artifacts
OPENTAG_MAX_ARTIFACT_BYTES=31457280
OPENTAG_MAX_ARTIFACTS=10
OPENTAG_EXECUTOR_SESSION_MODE=provider
OPENTAG_CODEX_APP_SERVER=true
OPENTAG_CODEX_CONTEXT_COMPACTION_THRESHOLD=0.85
OPENTAG_CODEX_HOME=/srv/opentag/data/providers/codex
OPENTAG_THREAD_CONTEXT_MAX_ENTRIES=40
OPENTAG_THREAD_CONTEXT_MAX_CHARS=40000
```

MaxTag uses `<workspace root>/<project id>` when that directory exists, falling
back to the configured root. A `shell` grant exposes brokered `workspace_list`,
`workspace_read`, and literal `workspace_search`; explicit write permission adds
atomic `workspace_write` and direct-exec `workspace_run`. File writes use an
expected SHA-256 precondition and the inherited exact-argument approval policy.
Commands are always one-time approved, must match the grant's executable
allowlist, and never pass through shell string parsing. An empty command
allowlist exposes no command tool; there is no implicit executable set or `*`
wildcard. GitHub access remains
brokered and does not implicitly expose Bash, SSH, `gh`, or a GitHub token. The
process runner
kills the full child process group on cancellation or timeout, bounds retained
stdout/stderr, and filters service secrets such as Lark credentials from the CLI
environment. Additional variables must be named explicitly through
`OPENTAG_EXECUTOR_INHERIT_ENV`.

Codex agent turns run through `codex app-server` in the native `read-only` OS
sandbox with native web search disabled. MaxTag uses a service-owned
`CODEX_HOME`, seeds only `auth.json` on first use, and rejects unmanaged config;
personal MCP servers, hooks, and instructions are not inherited. One-shot Luna
memory work remains ephemeral through `codex exec`. A custom
`OPENTAG_CODEX_COMMAND` defaults to the legacy exec contract for wrapper
compatibility; set `OPENTAG_CODEX_APP_SERVER=true` only when that command
implements the app-server protocol. The app-server executor exposes `/compact`
for the current routed Codex thread, records provider-automatic compaction as an
Activity lifecycle item, and proactively compacts a completed persisted thread
when the provider reports context usage at or above
`OPENTAG_CODEX_CONTEXT_COMPACTION_THRESHOLD` (default `0.85`). Set the value above
`1` to disable proactive compaction. Claude ignores user/project setting sources, disables hooks, slash
commands and Chrome integration, exposes only native `Read`, `Glob`, and `Grep`,
and gives its native sandbox an empty network allowlist. All mutation, command,
and web access therefore enters through the scoped MaxTag MCP capability.
`browser_fetch` requires HTTPS, checks the route host policy and public DNS on
every redirect, rejects local/private destinations, and bounds the response.
Any remaining provider-native read event is recorded in Activity and Audit with
provider, category, risk and duration, but without paths, argument values, or
result bodies.

The executor ignores inherited MCP configuration and injects one per-run
`opentag` stdio proxy. Project policies must list allowed GitHub repositories,
Lark document IDs, and Base app tokens. An empty resource allowlist denies the
  call even when the provider grant is enabled. Agents receive only the memory
  scopes granted by the resolved project and thread policy. Workspace-shared
  public channels may read and write workspace, project, channel, and thread memory;
  isolated projects receive project, channel, and thread only; private channels get
  read-only workspace context; direct messages get thread memory only.
  Installation memory is never injected into project runs.
GitHub issue/comment, Lark document append, and Base record create/update tools
  also require an explicit write toggle in the inherited workspace policy or a
  custom project policy. The workspace default additionally pauses these writes
  for a one-time approval. Project and channel policy can inherit, require, or
  disable that approval gate. The broker persists the exact schema-validated
  arguments and a SHA-256 digest, rechecks current grants at execution time, and
  atomically claims an approval so concurrent or repeated clicks cannot repeat
  the remote write. A process loss after a remote call but before persistence is
  recorded as `execution_outcome_unknown` and is never replayed automatically.
  No delete, close, merge, or other destructive remote brokered operation is
  currently exposed. Workspace writes and commands now pass through the same
  gate; commands require approval even when a policy disables optional write
  confirmation.

```bash
OPENTAG_GITHUB_TOKEN=github_pat_...
OPENTAG_TOOL_MAX_CALLS_PER_RUN=100
OPENTAG_TOOL_CALL_TIMEOUT_MS=30000
OPENTAG_TOOL_APPROVAL_TTL_MS=900000
```

### External MCP registry

MaxTag can proxy deployment-approved stdio MCP servers through the same
per-run capability endpoint. The executor never receives the external command,
server environment, or credentials. Projects grant only a registered
`mcp:<server-id>` capability and an explicit subset of its tools. Tools omitted
from deployment policy or absent from current server discovery do not enter the
model context.

The registry is a deployment trust boundary, not project-authored data. An
installation owner/admin can health-check and enable or disable registered
servers from **Connectors**, while workspace/project policy selects the exact
server tools and read/write access. The console cannot create or edit a command.
`envRefs` maps child environment names to host
environment variable names, so the JSON contains no credential values. MaxTag
spawns the executable directly without a shell and passes only the runtime's
safe default environment plus those references.

Every tool requires a declared `read` or `write` risk. External writes use the
same durable exact-argument approval, atomic claim, current-grant recheck,
timeout, result limit, and redacted audit path as built-in writes. Discovery is
performed only for servers present in the resolved run grants; a newly exposed
remote tool is denied until explicitly added to registry policy.

```bash
export LINEAR_MCP_TOKEN=replace-me
export OPENTAG_EXTERNAL_MCP_SERVERS_JSON='{
  "servers": [{
    "id": "linear",
    "label": "Linear MCP",
    "command": "/opt/opentag/bin/linear-mcp",
    "args": ["--stdio"],
    "envRefs": {"LINEAR_TOKEN": "LINEAR_MCP_TOKEN"},
    "tools": [
      {"name": "search_issues", "risk": "read"},
      {"name": "create_issue", "risk": "write"}
    ]
  }]
}'
```

Server and standalone worker processes must receive the same registry JSON,
referenced environment variables, and `OPENTAG_DATA_DIR`. Runtime state lives in
`config/managed-connectors.json`; each process reloads it before discovery and
execution, so disabling a connector fences pending approved calls too. Health
checks can run while disabled and record only status, latency, approved tool
count, and a bounded error code. Connector APIs never return command, args,
cwd, environment reference names, or credential values.

### Agent-scheduled follow-ups

Projects can grant the **Standing work** tool group independently from other
tools. The agent can then list only the routines bound to its exact
workspace/project/client thread and propose one-time, interval, or daily work.
Create, pause, resume, and delete are brokered writes, so the inherited tool
approval policy persists and displays the exact schedule and target arguments
before any routine state changes. A lifecycle call rechecks both the current
grant and current thread ownership when it is proposed and again when approved.

One-time schedules require an absolute ISO timestamp with an explicit offset,
for example `2026-08-14T09:00:00+08:00`. At the scheduled instant, the routine
is staged atomically and disables itself; repeated scheduler ticks and process
restarts cannot stage a second execution for the same due timestamp. The queued
run retains the original client thread, root message, topic, visibility,
workspace, and project route, so its result returns to the conversation that
created it.

The brokered create tool can set `notificationMode` to `every_result`,
`failures_only`, or `silent`. In failures-only mode, `failureThreshold` is 1-10
and `recoveryNotification` controls the one-shot recovery notice. These values
are part of the exact approval arguments. Silent runs still execute, meter
usage, update history, and surface governance approvals; they do not create a
progress card or ordinary result reply.

The direct bilingual command surface remains available for authorized members:

```text
schedule once 2026-08-14T09:00:00+08:00: Check release status
安排一次 2026-08-14T09:00:00+08:00：检查发布状态
schedule every 30m: Check CI failures
schedule daily 09:00 Asia/Shanghai: Summarize open work
routines
pause routine <id>
```

Operators can inspect exact arguments and decide active requests in **Activity**
or through `GET /v1/tool-approvals` and
`POST /v1/tool-approvals/:id/{approve|reject}`. Lark cards expose approval only
when the complete argument JSON is safe to display; oversized or
sensitive-looking payloads must be reviewed in the console. Audit and metrics
use redacted summaries and status counts rather than argument values.

When a CLI creates a user-facing file, the executor asks it to declare the
project-relative path in its final response. MaxTag strips that declaration,
rejects traversal and symlink escapes, limits count and size, copies the bytes
to `OPENTAG_ARTIFACT_ROOT`, and emits a durable artifact event. A CLI may instead
declare a `link` or `pull-request` URL; MaxTag accepts only credential-free
public HTTPS references and requires pull-request paths to end in
`/pull/<number>`. Reference artifacts remain durable even when local file
storage is unavailable. Server and standalone worker processes must use the
same artifact root for file artifacts (the default is
`<OPENTAG_DATA_DIR>/artifacts`). Activity never turns an arbitrary host path
into a download; it serves only managed, hash-matching file artifacts to an
authorized operator.

Provider session continuity is enabled by default. MaxTag records the Codex
thread id or Claude session id against the platform/workspace/project/thread and
resumes it on the next run. Claude uses `stream-json` input and Codex uses the
app-server protocol; both advertise `live`. Codex steers against the exact
active turn ID and interrupts that same turn on cancellation. If a steer loses
the completion race, it is not acknowledged and becomes the next durable turn.
If a recorded Codex thread exhausts its context window, MaxTag first invokes
native `thread/compact/start` on that same provider thread, waits for a
`contextCompaction` or `thread/compacted` confirmation, and sends one internal
continuation without replaying the original user message or attachments. If
native compaction is unavailable, or a recorded Codex/Claude provider session is
missing, MaxTag invalidates only that scoped session and retries once using the
bounded durable thread transcript. A second failure is terminal for that run, so
recovery cannot loop or disturb other project topics.
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
      "text": "/maxtag summarize this repo",
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

Public generic clients require `mentionsAgent: true`, a `/maxtag` or `@maxtag`
trigger, or an already established thread with `rootMessageId` or `topicId`.
The former `/opentag` and `@opentag` triggers remain compatibility aliases.
Chat-only events do not silently turn a whole group into an active session.

Binary generic-client attachments use `contentBase64`; `localPath` is rejected.
HTTP(S) URLs can remain remote references. `OPENTAG_MAX_ATTACHMENT_BYTES`
defaults to 30 MB and is checked before decoded bytes are written.

## Lark Add-Bot Onboarding

The default single-workspace experience is deliberately configuration-free for
group members. An installation owner configures the Lark app, default project,
and executor once. A member then adds MaxTag from the group's **Bots** menu and
mentions `@MaxTag` in the first message. MaxTag routes the group to the default
project and persists the topic route; replies in that topic do not need another
mention.

Keep `OPENTAG_LARK_REQUIRE_BINDING=false` for this add-bot-and-mention flow.
Project access policy is still evaluated before every run. Use explicit pairing
only when one bot must route different groups into different projects.

## Optional Chat Pairing

Open **Connectors**, choose Lark, Telegram, or GitHub and a target project, then generate
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
# Optional multi-project gate; false is the normal add-bot-and-mention flow.
OPENTAG_LARK_REQUIRE_BINDING=true
OPENTAG_TELEGRAM_REQUIRE_BINDING=true
OPENTAG_GITHUB_REQUIRE_BINDING=true
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
OPENTAG_LARK_EVENT_MODE=long-connection
OPENTAG_LARK_DOMAIN=feishu
OPENTAG_LARK_APP_ID=cli_xxx
OPENTAG_LARK_APP_SECRET=xxx
OPENTAG_LARK_BOT_OPEN_ID=ou_xxx
OPENTAG_LARK_VERIFICATION_TOKEN=xxx
OPENTAG_LARK_ENCRYPT_KEY=xxx
```

Use `OPENTAG_LARK_DOMAIN=lark` for `open.larksuite.com`, or
`OPENTAG_LARK_BASE_URL=https://...` for a custom OpenAPI host.

For Feishu/Lark, the preferred production ingress is the platform long
connection event channel. It does not require a public callback URL. The
supervised `opentag-lark-bridge` service consumes events as the app bot and
posts them to the loopback MaxTag server. Set
`OPENTAG_LARK_EVENT_MODE=webhook` only for deployments that want HTTP callbacks;
otherwise `/v1/lark/events` remains disabled. Webhook mode refuses to start
without a Verification Token or Encrypt Key. Register
`https://your-host/v1/lark/events` as the event callback. When an
Encrypt Key is configured, MaxTag verifies
`X-Lark-Signature` against the untouched request body before decrypting it.
Encrypted URL-verification challenges without signature headers are accepted
only after AES decryption and a matching configured Verification Token. Normal
webhook events always require a valid signature when
`OPENTAG_LARK_ENCRYPT_KEY` is set. Callback bodies are capped at 1 MiB by
default; tune `OPENTAG_LARK_CALLBACK_MAX_BYTES` only when a documented Lark
payload requires it.

Run the readiness harness before the first live workspace smoke:

```bash
npm run smoke:lark -- --json
```

The default harness checks configuration, long-connection readiness instructions,
and Lark tenant-token access without sending messages. To prove bot-in-chat text
and progress-card create/update, add a real chat id and `--send`:

```bash
npm run smoke:lark -- --send --chat-id=oc_xxx --json
```

To prove long-connection ingress, run a bounded consumer and mention the bot in
the test group before the timeout:

```bash
npm run smoke:lark -- --consume-events --event-timeout-ms=60000 --json
```

If `lark-cli` uses a named profile for the app, add
`--lark-cli-profile=opentag-smoke` or set `OPENTAG_LARK_CLI_PROFILE`.
The profile's `feishu`/`lark` brand controls the WebSocket endpoint and is
independent of `OPENTAG_LARK_DOMAIN`, which controls OpenAPI delivery. It is
valid for those settings to differ when an existing app requires it. If the
event bus reports `1000040351: Incorrect domain name`, recreate or select the
profile with the other brand and leave the working OpenAPI domain unchanged.
When the supervised bridge is already running, add
`--bridge-health-url=http://127.0.0.1:3080/health` or set
`OPENTAG_LARK_BRIDGE_HEALTH_URL` to prove the message consumer is ready.

To route long-connection messages into a running local MaxTag server, run the
bridge in a second terminal:

```bash
OPENTAG_SERVER_URL=http://127.0.0.1:3077 \
npm run bridge:lark -- --workspace-id=dev-workspace --lark-cli-profile=opentag-smoke
```

The bridge consumes `im.message.receive_v1` with `lark-cli event consume --as bot`
and posts normalized source-thread events to `/v1/client/events`, so message
testing does not need a public HTTPS callback. Lark long connections carry event
subscriptions only; interactive-card callbacks use the separately authenticated
`/v1/lark/card-actions` webhook endpoint. In supervised
deployments set `OPENTAG_SERVER_URL=http://127.0.0.1:3077`,
`OPENTAG_LARK_BRIDGE_EVENT_KEYS=im.message.receive_v1`, and
`OPENTAG_LARK_BRIDGE_OBSERVABILITY_PORT=3080`. When
`OPENTAG_CLIENT_INGRESS_TOKEN` is set, pass the same token to the bridge through
`--token=...` or the environment. Set `OPENTAG_LARK_CLI_PROFILE` when the
service account should use a named `lark-cli` profile instead of the default
machine profile. Validate it with
`lark-cli --profile PROFILE event consume im.message.receive_v1 --as bot --timeout 8s`;
schema inspection alone does not prove the WebSocket domain is correct.

For webhook deployments, run the same harness with
`--event-mode=webhook` and set `OPENTAG_PUBLIC_CALLBACK_URL`,
`OPENTAG_LARK_VERIFICATION_TOKEN`, and `OPENTAG_LARK_ENCRYPT_KEY`.

Optional flags extend the evidence gate: `--history --thread-id=om_xxx` checks
existing-topic history visibility, `--file --send --chat-id=oc_xxx` checks file
artifact upload, and `--image --send --chat-id=oc_xxx` proves the native image
upload path. The harness emits milestone ids such as `M1_TENANT_TOKEN`,
`M1_BOT_INFO`, `M1_VISIBLE_CHATS`, `M1_TARGET_CHAT_VISIBLE`,
`M1_LARK_CLI_PROFILE`, `M1_LARK_BRIDGE_HEALTH`,
`M1_LONG_CONNECTION_EVENT`, `M2_TEXT_DELIVERY`, `M2_PROGRESS_CARD`,
`M3_THREAD_HISTORY`, `M6_FILE_DELIVERY`, and `M6_IMAGE_DELIVERY`.

To publish machine-readable milestone evidence, set a separate smoke callback
endpoint. This is not the Lark event callback:

```bash
OPENTAG_SMOKE_CALLBACK_URL=https://evidence.example/opentag \
OPENTAG_SMOKE_CALLBACK_TOKEN=xxx \
OPENTAG_SMOKE_RUN_ID=lark-prod-smoke-2026-08-12 \
npm run smoke:lark -- --send --history --file --chat-id=oc_xxx --thread-id=om_xxx \
  --evidence-jsonl=artifacts/lark-prod-smoke-2026-08-12.jsonl --json
```

Each POST has event `opentag.smoke.milestone`, platform `lark`, the stable
`runId`, and one milestone object. `M0_MILESTONE_CALLBACKS` records whether the
evidence callback itself succeeded. `--evidence-jsonl` writes the same milestone
stream plus a final `opentag.smoke.summary` record to a JSONL file under the
current worktree.

Use the separate standing-work harness to prove that a one-time routine runs
once and returns to the exact source topic. Its default mode is a read-only
preflight. Live creation requires `--send`; a development server configured
with the manual scheduler additionally requires the explicit `--tick` flag:

```bash
npm run smoke:lark-routine -- --server-url=http://127.0.0.1:3077 \
  --bridge-health-url=http://127.0.0.1:3080/health \
  --workspace-id=dev-workspace --project-id=opentag \
  --chat-id=oc_xxx --root-message-id=om_xxx --json

npm run smoke:lark-routine -- --send --tick \
  --server-url=http://127.0.0.1:3077 \
  --bridge-health-url=http://127.0.0.1:3080/health \
  --workspace-id=dev-workspace --project-id=opentag \
  --chat-id=oc_xxx --root-message-id=om_xxx \
  --evidence-jsonl=artifacts/lark-routine-smoke.jsonl --json
```

Before a manual tick, the harness refuses to proceed when another routine in
the selected workspace is already due. Success requires one scheduled
execution, atomic disablement of the one-time routine, a completed agent run,
the original workspace/project/channel/root/topic/visibility route, one
delivered `lark.text` receipt in that topic, and zero failed run deliveries.
Do not treat the read-only preflight as delivery evidence.

Existing-topic context import is enabled for HTTP Lark transport. It uses
`container_id_type=thread`, requests up to
`OPENTAG_LARK_THREAD_HISTORY_MAX_MESSAGES` messages, and retries a failed
thread import after `OPENTAG_LARK_THREAD_HISTORY_RETRY_MS`. The defaults are 50
messages and 1 hour. If the app lacks Lark message-history scopes or cannot see
that thread, MaxTag records `thread_context_import_failed` and continues the
current run with the live event context. Chat metadata and thread-history reads
are separate permissions: successful `im/v1/chats/:chat_id` access does not
prove that `im/v1/messages` history listing is authorized. Cold-start chat
metadata lookup uses `OPENTAG_LARK_CHAT_INFO_TIMEOUT_MS` (10 seconds by default)
before recording the lookup as unavailable. For app-identity group history,
enable `im:message` or `im:message:readonly` and also the sensitive
`im:message.group_msg` scope, then publish the app version so the permission is
effective.

Old groups use a separate operator-controlled initialization flow; this is not
the disconnect backfill above. On the first group invocation MaxTag posts a
one-time card with **Start now** and **Import the last 30/90/180 days**. The
card shows the group's current Project binding; each group makes its own range
choice, while any number of groups may share the same Project memory, assigned
Skills, and agent policy. The same flow is available in Console → Connectors →
Lark with a custom date range and bounded preview. Historical messages are archived directly as
source-thread context and never replayed as agent requests, even when an old
message mentions MaxTag. A durable job advances in
`OPENTAG_LARK_HISTORY_IMPORT_WINDOW_MS` windows, checkpoints after each window,
recovers stale claims after restart, de-duplicates source message ids, and
retains failure state for operator retry. Optional Memory Analysis processes
the group's canonical transcript in bounded batches while preserving the
original group/topic/message provenance, with no dependency on a provider-owned session. It
creates only Project/Company memory proposals; nothing enters approved memory
until an operator accepts it. Proposal reasons include the supporting Lark
message id and timestamp when the model supplies the requested evidence
citation. The same Lark history scopes described above are required.

Subscribe the app to message events through long connection or webhook. The
progress-card Stop and Take over buttons are accepted only when their
`open_message_id`, `open_chat_id`, and `run_id` match a delivered card receipt
and the clicking Lark identity can invoke that project. Take over atomically
records the acting member, cancels the exact run and queued follow-ups, and
posts a handoff in the original topic. MaxTag returns the card-action toast
immediately; the worker observes the durable cancellation request and patches
the card to its terminal state.

For a real Stop proof, start the observer before sending a deliberately long
task to the target group, then click **Stop** when its progress card appears:

```bash
npm run smoke:lark-stop -- \
  --server-url=http://127.0.0.1:3077 \
  --bridge-health-url=http://127.0.0.1:3080/health \
  --workspace-id=dev-workspace --project-id=opentag --chat-id=oc_xxx \
  --evidence-jsonl=artifacts/lark-stop-smoke.jsonl --json
```

The observer passes only when the bridge receives and delivers a new
`card.action.trigger`, the exact run becomes `cancelled`, the original card
receipt receives a later terminal update, and the run has zero failed
deliveries. `--run-id=RUN_ID` can pin an already-started active run.

For a real shared-collaboration proof, run the Take over observer before sending
a deliberately long task. After the progress card appears, send one follow-up
in the same topic, wait for the observer to confirm it is queued, then click
**Take over**:

```bash
npm run smoke:lark-takeover -- \
  --server-url=http://127.0.0.1:3077 \
  --bridge-health-url=http://127.0.0.1:3080/health \
  --workspace-id=dev-workspace --project-id=opentag --chat-id=oc_xxx \
  --evidence-jsonl=artifacts/lark-takeover-smoke.jsonl --json
```

This stricter observer also requires the clicking Lark member in a durable
`human_takeover` event, cancellation of that exact queued follow-up, a tracked
handoff text in the original topic/root, and the matching Organization Audit
entry. A plain Stop or unrelated card callback cannot satisfy it.

The callback implementation follows Feishu's documented
[signature and event-decryption protocol](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case?lang=en-US).
Card controls follow the documented
[card callback contract](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks?lang=zh-CN).
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
OPENTAG_TELEGRAM_BOT_USERNAME=MaxTagBot
OPENTAG_TELEGRAM_WEBHOOK_SECRET=replace-with-a-random-secret
OPENTAG_TELEGRAM_WORKSPACE_ID=dev-workspace
```

Register `https://your-host/v1/telegram/events` as the bot webhook and pass the
same secret as `secret_token` when calling Telegram `setWebhook`. Set
`OPENTAG_TELEGRAM_REQUIRE_BINDING=true` when only chats paired or explicitly
configured in the MaxTag **Connectors** view should be accepted. Supergroup forum
`message_thread_id` values become stable MaxTag threads; channel bindings map
those topics to project-scoped identity, grants, and memory.

Incoming Telegram file IDs are resolved with `getFile`, downloaded through the
Bot API, bounded, and copied into the same managed content store before work is
queued. Local managed artifacts are uploaded with `sendDocument`.

## Slack Events API Mode

Slack is a native client over the signed Events API. Local development uses
`OPENTAG_SLACK_TRANSPORT=memory`; a real app uses:

```bash
OPENTAG_SLACK_TRANSPORT=http
OPENTAG_SLACK_BOT_TOKEN=xoxb-...
OPENTAG_SLACK_BOT_USER_ID=U0123456789
OPENTAG_SLACK_SIGNING_SECRET=replace-with-signing-secret
OPENTAG_SLACK_WORKSPACE_ID=dev-workspace
OPENTAG_SLACK_REQUIRE_BINDING=true
```

Set the Event Subscriptions request URL to
`https://your-host/v1/slack/events`, subscribe to `app_mention` and
`message.im`, and grant `app_mentions:read`, `im:history`, `chat:write`, and
`files:write`. MaxTag verifies the `v0` HMAC against the raw body, rejects
requests outside the configured five-minute replay window, and answers the URL
verification challenge only after authentication. A `/pair CODE` message binds
the Slack channel to a MaxTag project. Channel roots and Slack `thread_ts`
values become isolated MaxTag threads with the same access, memory, run, and
delivery policies as Lark and Telegram.

Progress is posted once and updated with `chat.update`; final messages and
artifacts remain in the source thread. Incoming private Slack file URLs are
downloaded with the bot token, bounded, and copied into managed content before
the executor can access them. Artifact uploads use
`files.getUploadURLExternal` followed by `files.completeUploadExternal`.

## GitHub Comments Mode

Local development defaults to `OPENTAG_GITHUB_TRANSPORT=memory`, so issue and
pull request comments can be exercised without writing to GitHub. For a real
repository webhook:

```bash
OPENTAG_GITHUB_TRANSPORT=http
OPENTAG_GITHUB_APP_ID=123456
OPENTAG_GITHUB_APP_INSTALLATION_ID=987654
OPENTAG_GITHUB_APP_PRIVATE_KEY_FILE=/etc/opentag/github-app.pem
OPENTAG_GITHUB_BOT_LOGIN=MaxTagBot
OPENTAG_GITHUB_WEBHOOK_SECRET=replace-with-a-random-secret
OPENTAG_GITHUB_WORKSPACE_ID=dev-workspace
OPENTAG_GITHUB_REQUIRE_BINDING=true
```

MaxTag signs a short-lived App JWT, exchanges it for an installation token,
caches the token only until five minutes before expiry, and refreshes it
automatically. The PEM stays in the configured file and the exchanged token is
never persisted. `OPENTAG_GITHUB_TOKEN` remains a legacy alternative for local
or transitional deployments; startup fails if it is combined with the GitHub
App fields or if the App configuration is incomplete.

Register `https://your-host/v1/github/events` as a JSON webhook, set the same
secret, and subscribe to **Issue comments**. The App installation must be
allowed to create and update comments in the target repositories. A `/pair CODE` comment binds
the whole `owner/repo` channel to a project; each `owner/repo#issue` then becomes
an isolated MaxTag thread. The first comment in a new issue must mention the
configured bot login (or use `/maxtag`; `/opentag` remains an alias), while later comments in that issue
continue the established thread without another mention.

Progress uses one comment that is updated in place. Final responses are new
comments. MaxTag adds hidden ownership markers and ignores both those markers
and the configured bot account on ingress so its own comments cannot start a
reply loop.
