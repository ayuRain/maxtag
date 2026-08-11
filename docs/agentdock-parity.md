# AgentDock Parity Notes

OpenTag should catch up to AgentDock on operational reliability while keeping a
different product shape: one workspace-level bot serving many projects across
many clients.

## Already Started

| Capability | OpenTag status |
| --- | --- |
| Client-neutral event model | `SourceThread`, `SourceMessage`, and `PlatformAdapter` |
| Lark first client | Lark normalize path, progress cards, dry-run server route, and HTTP OpenAPI transport |
| Multiple clients | Native Lark and Telegram ingress/delivery plus generic `/v1/client/events` for adapters in development |
| Scoped memory | Global, workspace, project, and thread file scopes; Lark groups route to project scope; remember/forget commands |
| Session/channel binding | Configurable channel/project bindings with mention-only or always-on activation |
| Self-service pairing | Lark and Telegram `/pair` commands use expiring, single-use, platform-bound codes; salted hashes persist across restarts, successful pairing creates a configured project route, and operators can revoke invitations or unbind chats |
| Topic continuation | Mention establishes a Lark or Telegram topic binding; later messages in that topic continue without repeating the mention |
| Project agent policy | File-backed per-project identity, instructions, Codex/Claude choice, tool grants, network policy, and audit history |
| Durable delivery | SQLite WAL outbox, turn delivery records, atomic cross-process claims, scoped cancel, stale recovery, and bindings; legacy file mode remains available |
| Agent run queue | SQLite WAL run status, timeline events, cancel requests, inline or standalone worker claim, restart persistence, and stale recovery |
| Scheduled tasks | File-backed workspace/project routines with interval or daily schedules, IANA time zones, manual trigger, deduped execution claims, stale reclaim, and shared run-queue execution; Lark and Telegram topics support bilingual create/list/pause/resume/delete commands with requester audit |
| Inbound callback ledger | Lark token/timestamp and Telegram webhook-secret checks, event idempotency, and duplicate short-circuit |
| Native Telegram client | Bot API webhook normalization, forum topics, send/edit progress, reply chunking, outgoing files, and tracked delivery |
| Executor boundary | Project-selectable Codex and Claude dry-run/local CLI modes with bounded output, cancellation, timeout, and filtered child environments |
| Operator console authentication | Optional local-open mode plus configured Bearer automation and signed, expiring HttpOnly browser sessions; mutation requests carry per-session CSRF tokens |

## Gaps To Close

| AgentDock capability | OpenTag next step |
| --- | --- |
| More native clients | Add Slack, GitHub comment, QQ, and Web adapters behind the shared platform contract |
| Telegram production depth | Download inbound files and verify webhook/send/edit/file behavior against a live bot |
| High-volume storage | Normalize the current transactional SQLite state documents or add Postgres before high-volume multi-replica deployment; add retention and compaction metrics |
| Async run execution | Add production supervisor/deployment manifests and cross-process cancellation heartbeat |
| Turn delivery tracking | Add deployed reconciliation/smoke checks for stale card or reply delivery |
| Real Lark smoke | Verify app scopes, bot-in-chat permissions, text replies, and card patching against a live app |
| Pairing and binding governance | Add workspace roles and membership permission checks plus binding audit history and import/export; pairing consumption and binding creation are already one SQLite transaction |
| Encrypted Lark callbacks | Implement decrypt path before enabling encrypted events in production |
| Memory governance | Add durable write queue, audit history, approval policy, and admin restore |
| Routine production hardening | Move routine state and claims to the production database, run scheduler under a supervisor, and verify real Lark delivery and restart recovery |
| Dynamic workflows | Add saved workflow definitions and async workflow runs |
| Tooling depth | Replace direct CLI permission mapping with brokered GitHub, Lark Docs/Base, browser, and shell tools |

## Product Constraint

AgentDock is a local workbench. OpenTag is a shared collaboration bot. Parity
should be measured by operational capability, not by copying AgentDock's object
model directly.
