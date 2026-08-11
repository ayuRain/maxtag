# AgentDock Parity Notes

OpenTag should catch up to AgentDock on operational reliability while keeping a
different product shape: one workspace-level bot serving many projects across
many clients.

## Already Started

| Capability | OpenTag status |
| --- | --- |
| Client-neutral event model | `SourceThread`, `SourceMessage`, and `PlatformAdapter` |
| Lark first client | Lark normalize path, progress cards, dry-run server route, and HTTP OpenAPI transport |
| Multiple future clients | Telegram stub plus Slack/GitHub entries in capability manifest |
| Scoped memory | Global, workspace, project, and thread file scopes; Lark groups route to project scope; remember/forget commands |
| Session/channel binding | Configurable channel/project bindings with mention-only or always-on activation |
| Topic continuation | Mention establishes a Lark topic binding; later messages in that topic continue without repeating the mention |
| Durable delivery skeleton | File-backed outbox, turn delivery records, scoped cancel, stale recovery, and bindings |
| Agent run queue | File-backed run status, timeline events, cancel requests, inline worker claim, and stale recovery |
| Inbound callback ledger | Lark token/timestamp checks, event idempotency, and duplicate short-circuit |
| Executor boundary | Codex dry-run and Claude placeholder behind `Executor` |

## Gaps To Close

| AgentDock capability | OpenTag next step |
| --- | --- |
| Durable IM outbox | Replace file store with SQLite/Postgres claim/retry worker |
| Async run execution | Split inline worker into independently deployed workers with durable resume |
| Turn delivery tracking | Add deployed reconciliation/smoke checks for stale card or reply delivery |
| Real Lark smoke | Verify app scopes, bot-in-chat permissions, text replies, and card patching against a live app |
| Binding governance | Add permission checks, audit history, and import/export for configured bindings |
| Encrypted Lark callbacks | Implement decrypt path before enabling encrypted events in production |
| Memory governance | Add durable write queue, audit history, approval policy, and admin restore |
| Scheduled tasks | Add workspace/project routines on top of the runtime |
| Dynamic workflows | Add saved workflow definitions and async workflow runs |
| Tooling depth | Wire GitHub, Lark Docs/Base, browser, and shell grants |

## Product Constraint

AgentDock is a local workbench. OpenTag is a shared collaboration bot. Parity
should be measured by operational capability, not by copying AgentDock's object
model directly.
