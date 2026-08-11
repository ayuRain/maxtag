# OpenTag Roadmap

## Phase 0: Repo Foundation

- Platform-neutral core contracts.
- Lark adapter shell.
- Executor abstraction for Codex and Claude.
- Progress card model that can render to Lark today and Slack/Telegram later.
- Selectable Lark delivery transport: memory dry-run locally, HTTP OpenAPI for
  real app bots.
- Global/workspace/project/thread memory scopes.
- Explicit scoped memory commands and admin API for remember, forget, and show.
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
- Standalone worker process that can claim the shared run queue while HTTP
  ingestion runs with `OPENTAG_AGENT_WORKER=manual`.
- Generic client ingress that maps non-Lark envelopes into the same run queue,
  memory scopes, and tracked text delivery.
- Native Telegram Bot API webhook/send/edit adapter with forum-topic routing,
  update idempotency, outgoing files, and tracked delivery.
- Shared file-backed workspace/project agent policy with per-project identity,
  instructions, executor selection, tool grants, network policy, and audit.
- Opt-in local Codex and Claude CLI execution with bounded output, process-group
  cancellation, timeout, project workspace resolution, and filtered child env.
- File-backed workspace/project routines with interval and daily schedules,
  deduped execution claims, stale reclaim, manual triggers, audit history, and
  deterministic bridging into the shared agent run queue. Lark and Telegram
  topics can create, list, pause, resume, and delete scoped standing work with
  requester audit.
- Operator console organized around projects, access, routines, activity,
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
- Normalize group messages, mentions, files, images, and topic/thread metadata.
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
- Queue accepted Lark events quickly, then execute runs through the shared worker
  path instead of blocking callback delivery.
- Keep operator recovery scoped to a run, thread, workspace, project, target, or
  kind so one noisy topic can be stopped without disrupting other projects.
- Keep the Lark implementation behind `PlatformAdapter`; do not let Lark field
  names leak into core tables or executor prompts.

## Phase 2: Agent Runs

- Harden Codex and Claude local CLI execution behind the common `Executor`
  contract with provider event parsing and runtime evidence.
- Add production supervisor/deployment manifests for independent worker
  processes.
- Add cross-process cancellation heartbeat for active runs.
- Support turn steering while a run is active.
- Attach artifacts: final message, file, patch, hosted report, PR link.
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
- Production routine store, supervised scheduler deployment, and live Lark
  delivery/restart smoke evidence.
- Watchers: PR, CI, issue, alert, and document monitors.
- Add richer routine status and recent-result summaries to each thread.

## Phase 5: Multi-Platform

- Keep native platform webhooks thin by mapping them into `/v1/client/events`.
- Harden Telegram with inbound file downloads and live bot webhook/delivery
  smoke tests.
- Slack adapter can map thread_ts to `SourceThread`.
- GitHub issue/PR comments can become first-class work threads.
