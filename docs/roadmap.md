# OpenTag Roadmap

## Phase 0: Repo Foundation

- Platform-neutral core contracts.
- Lark adapter shell.
- Executor abstraction for Codex and Claude.
- Progress card model that can render to Lark today and Slack/Telegram later.
- Selectable Lark delivery transport: memory dry-run locally, HTTP OpenAPI for
  real app bots.
- SQLite-backed global/workspace/project/thread memory documents with
  transactional cross-process writes, immutable actor-attributed revisions,
  legacy Markdown import, history, and restore.
- Explicit scoped memory commands and admin API for remember, forget, show,
  history, and restore.
- SQLite WAL outbox, inbound event ledger, turn delivery tracker, and configured
  channel/project bindings, with transactional claims across server and worker.
- SQLite-backed Lark/Telegram pairing invitations with short-lived single-use
  codes, hashed persistence, atomic project route creation, revocation, and
  cascading chat unbind; existing JSON state imports on first startup.
- SQLite-backed workspace members, stable cross-client identity links,
  open/workspace/members project access modes, project roles, and capability
  checks on every external client ingress.
- Outbox recovery controls for stale `sending` records and scoped cancellation.
- SQLite WAL agent run ledger with status, cancel request, timeline events, and
  restart-safe cross-process claims.
- Durable run queue with inline worker claim, startup stale recovery, and manual
  worker/recovery API controls.
- Durable same-thread steering mailbox with atomic create-or-steer arbitration,
  executor live-input contract, ordered next-turn fallback, shared-thread stop
  commands, and cross-process cancellation polling.
- Standalone worker process that can claim the shared run queue while HTTP
  ingestion runs with `OPENTAG_AGENT_WORKER=manual`.
- Generic client ingress that maps non-Lark envelopes into the same run queue,
  memory scopes, and tracked text delivery.
- Native Telegram Bot API webhook/send/edit adapter with forum-topic routing,
  update idempotency, managed inbound downloads, outgoing files, and tracked
  delivery.
- Content-addressed inbound attachment storage isolated by workspace, project,
  thread, and message; generic base64 upload rejects host path injection.
- Managed CLI artifact declarations with traversal/symlink/size validation,
  durable run events, native Lark/Telegram delivery, and authenticated
  integrity-checked Activity downloads.
- Shared file-backed workspace/project agent policy with per-project identity,
  instructions, executor selection, tool grants, network policy, and audit.
- Opt-in local Codex and Claude CLI execution with bounded output, process-group
  cancellation, timeout, project workspace resolution, and filtered child env.
- SQLite WAL-backed workspace/project routines with interval and daily
  schedules, atomic cross-process claims, stale reclaim, manual triggers, audit
  history, deterministic bridging into the shared agent run queue, and
  inline/external/manual scheduler modes. Lark and Telegram topics can create,
  list, pause, resume, and delete scoped standing work with requester audit.
- SQLite WAL-backed project workflow DAGs with immutable execution snapshots,
  manual and typed-event triggers, event-id deduplication, atomic node claims,
  dependency failure propagation, and deterministic shared-run-queue bridging.
- Operator console organized around projects, access, routines, workflows, activity,
  scoped memory, delivery, and project-aware agent previews.
- Optional operator authentication with Bearer automation, signed HttpOnly
  browser sessions, named multi-token principals, workspace-scoped collection
  and object authorization, owner/admin/viewer roles, authoritative audit actor,
  mutation CSRF protection, and a separate generic-client ingress credential.
- Memory and GitHub tool contracts.

## Phase 1: Lark Tag MVP

- Add operator credential CRUD/rotation, finer-grained capabilities, and
  optional SSO/OIDC on top of the environment-configured named principals.
- Add binding audit/export and optional actor-restricted invitations around the
  transactional pairing and binding operation.
- Verify Lark callbacks with token/timestamp checks; add event decrypt before
  production encrypted callbacks.
- Extend rich-post extraction beyond the implemented text, file, image, audio,
  video, mention, and topic/thread normalization.
- Create or bind `SourceThread` records from Lark group/topic events, with
  channel-level project assignment for group memory.
- Require mention for the first handled group topic by default, then allow
  follow-up messages in the established topic without repeating the mention.
- Resolve workspace and project identity before every run.
- Support `remember`/`forget` commands for global, workspace, project, and
  thread memory without invoking the full executor.
- Render live progress cards with checklist items, stop action, and final state.
- Send text replies and interactive progress cards through a real Lark app bot
  once credentials and scopes are configured.
- Short-circuit duplicate Lark events by `event_id` or message id.
- Add retention, compaction, and queue-depth metrics to the SQLite-backed inbound
  ledger and worker-backed durable outbound queue.
- Add retention/compaction policy, revision diffs, export, and optional approval
  gates to the SQLite-backed memory history.
- Queue accepted Lark events quickly, then execute runs through the shared worker
  path instead of blocking callback delivery.
- Keep operator recovery scoped to a run, thread, workspace, project, target, or
  kind so one noisy topic can be stopped without disrupting other projects.
- Keep the Lark implementation behind `PlatformAdapter`; do not let Lark field
  names leak into core tables or executor prompts.

## Phase 2: Agent Runs

- Harden Codex and Claude local CLI execution behind the common `Executor`
  contract with provider event parsing and runtime evidence.
- Add production supervisor/deployment manifests for independent worker and
  scheduler processes.
- Add true mid-turn Codex steering when its provider exposes a stable streaming
  input API. Claude already accepts live `stream-json` follow-ups, and both CLI
  adapters resume provider sessions with durable transcript recovery.
- Add hosted interactive reports and first-class PR/link artifact producers on
  top of the implemented managed file/report/chart/patch path.
- Add resumable execution checkpoints and lease heartbeats so a replacement
  worker can continue interrupted runs instead of restarting them from scratch.

## Phase 3: Access Bundles

- Channel/thread-level tool grants.
- GitHub App installation grants.
- Lark Docs/Base grants.
- Secret indirection: executors receive capabilities, not raw global secrets.
- Default-deny network and tool policy.

## Phase 4: Proactivity

- Routine foundation: scheduled summaries, channel digests, and recurring checks
  can run through the shared executor and delivery path; each thread has a
  bilingual standing-work command surface.
- Workflow foundation: saved agent DAGs can run manually or from authenticated,
  idempotent typed events; intermediate nodes remain internal and sink nodes
  publish through a configured client destination.
- Supervised scheduler deployment, queue-depth/lease metrics, and live Lark
  delivery/restart smoke evidence.
- Native watcher producers: PR, CI, issue, alert, and document monitors.
- Add branching/parallel workflow editing, execution cancellation, node retry,
  and per-workflow queue metrics without allowing arbitrary in-process scripts.
- Add richer routine status and recent-result summaries to each thread.

## Phase 5: Multi-Platform

- Keep native platform webhooks thin by mapping them into `/v1/client/events`.
- Run live Telegram webhook/download/delivery smoke tests for the implemented
  native file pipeline.
- Slack adapter can map thread_ts to `SourceThread`.
- GitHub issue/PR comments can become first-class work threads.
