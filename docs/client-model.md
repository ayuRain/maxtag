# Client Model

OpenTag treats Lark, Telegram, Slack, GitHub comments, and future surfaces as
clients of the same thread-agent core.

## Core Objects

- `SourceThread`: the shared work context. Examples: Lark topic, Telegram chat,
  Slack thread, GitHub issue, GitHub pull request comment thread.
- `PlatformAdapter`: normalizes inbound events and renders outbound progress.
- `ProgressSurface`: the best available UI for that client. Lark uses cards;
  Telegram can use edited receipts; GitHub can use comments and checklists.
- `AccessBundle`: thread-level tool and credential grants.
- `Executor`: Codex, Claude, or another agent runner.

## Current Status

- Lark: first concrete adapter shell.
- Telegram: placeholder adapter to keep the core honest.
- Slack: planned.
- GitHub: planned as both a tool provider and a source client.

The goal is not to clone AgentDock feature-for-feature. AgentDock is the mature
workbench; OpenTag is the shared-thread product layer that can reuse selected
AgentDock ideas behind a platform-neutral boundary.

