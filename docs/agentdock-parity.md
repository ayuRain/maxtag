# AgentDock Parity Notes

OpenTag should catch up to AgentDock on operational reliability while keeping a
different product shape: one workspace-level bot serving many projects across
many clients.

## Already Started

| Capability | OpenTag status |
| --- | --- |
| Client-neutral event model | `SourceThread`, `SourceMessage`, and `PlatformAdapter` |
| Lark first client | Lark normalization, progress cards, HTTP OpenAPI transport, managed resource download, and native file/image replies |
| Multiple clients | Native Lark, Telegram, and GitHub issue/PR comment ingress/delivery plus generic `/v1/client/events` for adapters in development |
| Workspace agent profile | One workspace identity, instructions, executor, tool grants, and network policy are inherited by every project; identity and capability overrides are explicit and independently selectable |
| Scoped memory | SQLite-backed installation, workspace, project, and thread documents; runtime loads only granted scopes; public shared projects use workspace/project/thread, isolated projects use project/thread, private threads get read-only workspace context, and direct messages use thread only |
| Session/channel binding | Configurable channel/project bindings with mention-only or always-on activation |
| Self-service pairing | Lark, Telegram, and GitHub `/pair` commands use expiring, single-use, platform-bound codes; salted hashes persist across restarts, successful pairing creates a configured project route, and operators can revoke invitations or unbind chats |
| Topic continuation | Mention establishes a Lark topic, Telegram topic, or GitHub issue binding; later messages continue without another mention, reuse a provider session when available, and fall back to a bounded durable transcript |
| Shared task control | Durable cross-process follow-up mailbox, same-thread single-flight claims, live Claude stream input, resumed Codex next turns, authorized thread `/stop`, and operator steering/cancel controls |
| Project agent policy | File-backed project identity/capability inheritance modes, memory boundary, Codex/Claude choice, custom tool/network policy, and audit history |
| Workspace governance | SQLite-backed workspace members and project roles for client ingress, plus named operator tokens with workspace scopes, owner/admin/viewer control-plane roles, signed principal sessions, and authoritative operator audit identity |
| Durable delivery | SQLite WAL outbox, turn delivery records, atomic cross-process claims, scoped cancel, stale recovery, and bindings; legacy file mode remains available |
| Agent run queue | SQLite WAL run status, timeline events, cancel requests, inline or standalone worker claim, restart persistence, and stale recovery |
| Scheduled tasks | SQLite WAL-backed workspace/project routines with interval or daily schedules, IANA time zones, manual trigger, atomic cross-process claims, stale reclaim, deterministic run enqueue, inline/external/manual scheduler modes, and shared worker execution; Lark and Telegram topics support bilingual create/list/pause/resume/delete commands with requester audit |
| Dynamic workflows | SQLite WAL-backed saved DAGs with immutable execution snapshots, manual and typed-event triggers, event-id deduplication, atomic node claims, stale reclaim, dependency failure propagation, and deterministic bridging of every node into the shared run queue; sink nodes publish to a real client destination |
| Inbound callback ledger | Lark token/timestamp, Telegram webhook-secret, and GitHub HMAC-SHA256 checks, event idempotency, and duplicate short-circuit |
| Native Telegram client | Bot API webhook normalization, forum topics, send/edit progress, reply chunking, outgoing files, and tracked delivery |
| Native GitHub client | `issue_comment` webhook normalization, repository binding, issue/PR threads, create/update progress comments, chunked replies, self-loop suppression, and tracked delivery |
| Files and artifacts | Isolated content-addressed input storage; generic base64 upload; Lark/Telegram native download and upload; CLI artifact validation, durable timeline provenance, Activity downloads, and hash checks |
| Executor boundary | Project-selectable Codex and Claude dry-run/local CLI modes with bounded output, cancellation, timeout, and filtered child environments |
| Brokered tools | Per-run loopback MCP capability with schema validation, resource allowlists, explicit read/write grants, call/time/result limits, durable audit, scoped memory read/write, GitHub repository/issue reads plus issue/comment writes, Lark document read/append, and Base query/create/update; host credentials are not inherited by executors |
| Operator console authentication | Optional local-open mode plus configured Bearer automation and signed, expiring HttpOnly browser sessions; mutation requests carry per-session CSRF tokens |

## Gaps To Close

| AgentDock capability | OpenTag next step |
| --- | --- |
| More native clients | Add Slack, QQ, and Web adapters behind the shared platform contract |
| Telegram production depth | Verify webhook, download, send, edit, and file behavior against a live bot; local HTTP contract and end-to-end managed storage tests pass |
| GitHub production depth | Verify webhook, comment create/update, permissions, and delivery recovery against a live GitHub App or token; local HTTP contract and end-to-end routing tests pass |
| High-volume storage | Normalize the current transactional SQLite state documents or add Postgres before high-volume multi-replica deployment; add retention and compaction metrics |
| Async run execution | Add production supervisor/deployment manifests; durable cross-process cancellation polling is implemented |
| Provider-level live steering | Claude local CLI consumes active `stream-json` follow-ups; add true mid-turn steering for Codex when its provider exposes a stable streaming input API |
| Distributed provider sessions | Back provider sessions with shared provider state or sticky worker routing before using multiple executor hosts; host-scoped namespaces and transcript recovery prevent accidental cross-host resume today |
| Turn delivery tracking | Add deployed reconciliation/smoke checks for stale card or reply delivery |
| Real Lark smoke | Verify app scopes, bot-in-chat permissions, resource download, text/file/image replies, and card patching against a live app |
| Pairing and binding governance | Add binding audit/import/export and optional actor-restricted pairing invitations; project role enforcement already applies after a chat is routed, and pairing consumption plus binding creation are one SQLite transaction |
| Operator credential lifecycle | Add in-product credential creation, revocation, rotation, finer-grained operator capabilities, and optional SSO/OIDC; environment-configured named principals and workspace enforcement are implemented |
| Encrypted Lark callbacks | Implement decrypt path before enabling encrypted events in production |
| Memory governance | Add optional approval policy, retention/compaction controls, diff rendering, and export; explicit runtime scope grants, durable transactional writes, audit history, legacy import, and admin restore are implemented |
| Routine production hardening | Add production supervisor manifests, queue-depth/lease metrics, and real Lark delivery plus restart smoke evidence for the independent scheduler |
| Workflow production depth | Add native PR, CI, issue, alert, and document watcher producers; richer branching/parallel graph editing; cancellation and retry controls; queue metrics; and live Lark restart smoke evidence |
| Tooling depth | Add external MCP registry, destructive-operation approval flows, and hard container egress enforcement; non-destructive GitHub/Lark writes are explicitly grant-gated, while provider-native shell/browser tools remain bounded by executor policy rather than brokered |

## Product Constraint

AgentDock is a local workbench. OpenTag is a shared collaboration bot. Parity
should be measured by operational capability, not by copying AgentDock's object
model directly.
