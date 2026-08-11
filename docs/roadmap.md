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
- File-backed outbox, inbound event ledger, turn delivery tracker, and
  configured channel/project bindings.
- Outbox recovery controls for stale `sending` records and scoped cancellation.
- File-backed agent run ledger with status, cancel request, and timeline events.
- Durable run queue with inline worker claim, startup stale recovery, and manual
  worker/recovery API controls.
- Memory and GitHub tool contracts.

## Phase 1: Lark Tag MVP

- Verify Lark callbacks with token/timestamp checks; add event decrypt before
  production encrypted callbacks.
- Normalize group messages, mentions, files, images, and topic/thread metadata.
- Create or bind `SourceThread` records from Lark group/topic events, with
  channel-level project assignment for group memory.
- Resolve workspace and project identity before every run.
- Support `remember`/`forget` commands for global, workspace, project, and
  thread memory without invoking the full executor.
- Render live progress cards with checklist items, stop action, and final state.
- Send text replies and interactive progress cards through a real Lark app bot
  once credentials and scopes are configured.
- Short-circuit duplicate Lark events by `event_id` or message id.
- Persist inbound event idempotency and upgrade outbound deliveries from the
  file-backed MVP to a worker-backed durable queue.
- Queue accepted Lark events quickly, then execute runs through the shared worker
  path instead of blocking callback delivery.
- Keep operator recovery scoped to a run, thread, workspace, project, target, or
  kind so one noisy topic can be stopped without disrupting other projects.
- Keep the Lark implementation behind `PlatformAdapter`; do not let Lark field
  names leak into core tables or executor prompts.

## Phase 2: Agent Runs

- Run Codex and Claude through a common `Executor` contract.
- Split inline run execution into independent worker processes.
- Support turn steering while a run is active.
- Attach artifacts: final message, file, patch, hosted report, PR link.
- Move agent runs to resumable background workers with DB-backed timeline
  storage.

## Phase 3: Access Bundles

- Channel/thread-level tool grants.
- GitHub App installation grants.
- Lark Docs/Base grants.
- Secret indirection: executors receive capabilities, not raw global secrets.
- Default-deny network and tool policy.

## Phase 4: Proactivity

- Routines: scheduled summaries, channel digests, recurring checks.
- Watchers: PR, CI, issue, alert, and document monitors.
- Human-readable routine inventory in each thread.

## Phase 5: Multi-Platform

- Telegram adapter reaches parity for messages, files, and progress receipts.
- Slack adapter can map thread_ts to `SourceThread`.
- GitHub issue/PR comments can become first-class work threads.
