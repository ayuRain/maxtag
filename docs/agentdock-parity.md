# AgentDock Parity Notes

OpenTag should catch up to AgentDock on operational reliability while keeping a
different product shape: one workspace-level bot serving many projects across
many clients.

## Already Started

| Capability | OpenTag status |
| --- | --- |
| Client-neutral event model | `SourceThread`, `SourceMessage`, and `PlatformAdapter` |
| Lark first client | Lark normalize path, progress cards, dry-run server route, and HTTP OpenAPI transport |
| Multiple clients | Generic `/v1/client/events` ingress plus tracked text delivery for non-Lark clients |
| Scoped memory | Global, workspace, project, and thread file scopes; Lark groups route to project scope; remember/forget commands |
| Session/channel binding | Configurable channel/project bindings with mention-only or always-on activation |
| Topic continuation | Mention establishes a Lark topic binding; later messages in that topic continue without repeating the mention |
| Project agent policy | File-backed per-project identity, instructions, Codex/Claude choice, tool grants, network policy, and audit history |
| Durable delivery skeleton | File-backed outbox, turn delivery records, scoped cancel, stale recovery, and bindings |
| Agent run queue | File-backed run status, timeline events, cancel requests, inline or standalone worker claim, and stale recovery |
| Inbound callback ledger | Lark token/timestamp checks, event idempotency, and duplicate short-circuit |
| Executor boundary | Project-selectable Codex and Claude dry-runs behind `Executor` |

## Gaps To Close

| AgentDock capability | OpenTag next step |
| --- | --- |
| Native non-Lark adapters | Map Telegram/Slack/GitHub webhooks into `/v1/client/events` and add real send/edit transports |
| Durable IM outbox | Replace file store with SQLite/Postgres claim/retry worker |
| Async run execution | Add production supervisor/deployment manifests and cross-process cancellation heartbeat |
| Turn delivery tracking | Add deployed reconciliation/smoke checks for stale card or reply delivery |
| Real Lark smoke | Verify app scopes, bot-in-chat permissions, text replies, and card patching against a live app |
| Binding governance | Add permission checks and import/export for configured bindings; project policy changes now have an audit ledger |
| Encrypted Lark callbacks | Implement decrypt path before enabling encrypted events in production |
| Memory governance | Add durable write queue, audit history, approval policy, and admin restore |
| Scheduled tasks | Add workspace/project routines on top of the runtime |
| Dynamic workflows | Add saved workflow definitions and async workflow runs |
| Tooling depth | Wire GitHub, Lark Docs/Base, browser, and shell grants |

## Product Constraint

AgentDock is a local workbench. OpenTag is a shared collaboration bot. Parity
should be measured by operational capability, not by copying AgentDock's object
model directly.
