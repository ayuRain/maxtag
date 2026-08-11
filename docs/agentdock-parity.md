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
| Scoped memory | SQLite-backed global, workspace, project, and thread documents; transactional cross-process writes; immutable remember/forget/import/restore revisions with trusted actor provenance; Lark groups route to project scope |
| Session/channel binding | Configurable channel/project bindings with mention-only or always-on activation |
| Self-service pairing | Lark and Telegram `/pair` commands use expiring, single-use, platform-bound codes; salted hashes persist across restarts, successful pairing creates a configured project route, and operators can revoke invitations or unbind chats |
| Topic continuation | Mention establishes a Lark or Telegram topic binding; later messages continue without another mention and atomically steer one active thread instead of creating parallel runs |
| Shared task control | Durable cross-process follow-up mailbox, same-thread single-flight claims, live executor channel, ordered next-turn fallback for one-shot CLIs, authorized thread `/stop`, and operator steering/cancel controls |
| Project agent policy | File-backed per-project identity, instructions, Codex/Claude choice, tool grants, network policy, and audit history |
| Workspace governance | SQLite-backed workspace members and project roles for client ingress, plus named operator tokens with workspace scopes, owner/admin/viewer control-plane roles, signed principal sessions, and authoritative operator audit identity |
| Durable delivery | SQLite WAL outbox, turn delivery records, atomic cross-process claims, scoped cancel, stale recovery, and bindings; legacy file mode remains available |
| Agent run queue | SQLite WAL run status, timeline events, cancel requests, inline or standalone worker claim, restart persistence, and stale recovery |
| Scheduled tasks | SQLite WAL-backed workspace/project routines with interval or daily schedules, IANA time zones, manual trigger, atomic cross-process claims, stale reclaim, deterministic run enqueue, inline/external/manual scheduler modes, and shared worker execution; Lark and Telegram topics support bilingual create/list/pause/resume/delete commands with requester audit |
| Dynamic workflows | SQLite WAL-backed saved DAGs with immutable execution snapshots, manual and typed-event triggers, event-id deduplication, atomic node claims, stale reclaim, dependency failure propagation, and deterministic bridging of every node into the shared run queue; sink nodes publish to a real client destination |
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
| Async run execution | Add production supervisor/deployment manifests; durable cross-process cancellation polling is implemented |
| Provider-level live steering | Add a persistent Codex/Claude SDK or session runner that consumes the implemented live steering channel; bounded one-shot CLI adapters intentionally continue in the next turn |
| Turn delivery tracking | Add deployed reconciliation/smoke checks for stale card or reply delivery |
| Real Lark smoke | Verify app scopes, bot-in-chat permissions, text replies, and card patching against a live app |
| Pairing and binding governance | Add binding audit/import/export and optional actor-restricted pairing invitations; project role enforcement already applies after a chat is routed, and pairing consumption plus binding creation are one SQLite transaction |
| Operator credential lifecycle | Add in-product credential creation, revocation, rotation, finer-grained operator capabilities, and optional SSO/OIDC; environment-configured named principals and workspace enforcement are implemented |
| Encrypted Lark callbacks | Implement decrypt path before enabling encrypted events in production |
| Memory governance | Add optional approval policy, retention/compaction controls, diff rendering, and export; durable transactional writes, audit history, legacy import, and admin restore are implemented |
| Routine production hardening | Add production supervisor manifests, queue-depth/lease metrics, and real Lark delivery plus restart smoke evidence for the independent scheduler |
| Workflow production depth | Add native PR, CI, issue, alert, and document watcher producers; richer branching/parallel graph editing; cancellation and retry controls; queue metrics; and live Lark restart smoke evidence |
| Tooling depth | Replace direct CLI permission mapping with brokered GitHub, Lark Docs/Base, browser, and shell tools |

## Product Constraint

AgentDock is a local workbench. OpenTag is a shared collaboration bot. Parity
should be measured by operational capability, not by copying AgentDock's object
model directly.
