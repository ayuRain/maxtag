# AgentDock Parity Notes

OpenTag should catch up to AgentDock on operational reliability while keeping a
different product shape: one workspace-level bot serving many projects across
many clients.

## Already Started

| Capability | OpenTag status |
| --- | --- |
| Client-neutral event model | `SourceThread`, `SourceMessage`, and `PlatformAdapter` |
| Lark first client | Lark normalize path, progress cards, dry-run server route |
| Multiple future clients | Telegram stub plus Slack/GitHub entries in capability manifest |
| Scoped memory | Global, workspace, project, and thread file scopes |
| Durable delivery skeleton | File-backed outbox, turn delivery records, and bindings |
| Executor boundary | Codex dry-run and Claude placeholder behind `Executor` |

## Gaps To Close

| AgentDock capability | OpenTag next step |
| --- | --- |
| Durable IM outbox | Replace file store with SQLite/Postgres claim/retry worker |
| Turn delivery tracking | Add recovery/reconciliation for stale card or reply delivery |
| Session/channel binding | Add admin controls for activation mode and project assignment |
| Memory write queue | Move remember/forget writes into a durable async queue |
| Scheduled tasks | Add workspace/project routines on top of the runtime |
| Dynamic workflows | Add saved workflow definitions and async workflow runs |
| Tooling depth | Wire GitHub, Lark Docs/Base, browser, and shell grants |

## Product Constraint

AgentDock is a local workbench. OpenTag is a shared collaboration bot. Parity
should be measured by operational capability, not by copying AgentDock's object
model directly.
