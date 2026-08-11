# OpenTag Roadmap

## Phase 0: Repo Foundation

- Platform-neutral core contracts.
- Lark adapter shell.
- Executor abstraction for Codex and Claude.
- Progress card model that can render to Lark today and Slack/Telegram later.
- Global/workspace/project/thread memory scopes.
- File-backed outbox, turn delivery tracker, and thread bindings.
- Memory and GitHub tool contracts.

## Phase 1: Lark Tag MVP

- Verify Lark callbacks and event decrypt.
- Normalize group messages, mentions, files, images, and topic/thread metadata.
- Create or bind `SourceThread` records from Lark group/topic events.
- Resolve workspace and project identity before every run.
- Render live progress cards with checklist items, stop action, and final state.
- Persist inbound event idempotency and upgrade outbound deliveries from the
  file-backed MVP to a worker-backed durable queue.
- Keep the Lark implementation behind `PlatformAdapter`; do not let Lark field
  names leak into core tables or executor prompts.

## Phase 2: Agent Runs

- Run Codex and Claude through a common `Executor` contract.
- Support turn steering while a run is active.
- Attach artifacts: final message, file, patch, hosted report, PR link.
- Record agent-run timeline for admin and audit views.

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
