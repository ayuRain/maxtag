# Client Model

OpenTag treats Lark, Telegram, Slack, GitHub comments, and future surfaces as
clients of the same thread-agent core.

## Core Objects

- `SourceThread`: the shared work context. Examples: Lark topic, Telegram chat,
  Slack thread, GitHub issue, GitHub pull request comment thread.
- `Workspace`: the installation-level boundary for one global bot.
- `Project`: the group/repo/team boundary that keeps memory and grants separate.
- `PlatformAdapter`: normalizes inbound events and renders outbound progress.
- `ProgressSurface`: the best available UI for that client. Lark uses cards;
  Telegram can use edited receipts; GitHub can use comments and checklists.
- `AccessBundle`: thread-level tool and credential grants.
- `ScopedMemorySnapshot`: global, workspace, project, and thread memory loaded in
  deterministic order.
- `Executor`: Codex, Claude, or another agent runner.

## Current Status

- Lark: first concrete adapter shell with dry-run card rendering.
- Telegram: generic client event envelope can enter the shared run queue and use
  tracked text receipts; native Bot API send/edit is still pending.
- Slack: planned.
- GitHub: planned as both a tool provider and a source client.

The goal is not to clone AgentDock feature-for-feature. AgentDock is the mature
workbench; OpenTag is the shared-thread product layer that can reuse selected
AgentDock ideas behind a platform-neutral boundary.

## Routing Rule

Every inbound client event is normalized into the same sequence:

```text
client event -> SourceThread -> Workspace -> Project -> scoped memory -> Executor
```

Lark groups and topics are the first implementation target. Telegram chats,
Slack threads, and GitHub comments should only add adapters; they should not add
new executor or memory concepts.

Before a native adapter exists, a client can submit the normalized envelope to
`/v1/client/events`. The server records inbound idempotency, resolves bindings,
loads scoped memory, enqueues an agent run, and writes non-Lark progress/text
receipts into the same delivery ledger.
