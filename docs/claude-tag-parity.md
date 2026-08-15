# Claude Tag Parity

MaxTag follows the same product center as Claude Tag: one visible workspace bot
serves many team channels while keeping each channel's work controllable. It
does not copy Claude Tag's implementation or AgentDock's local-workbench object
model.

Reference behavior: [Claude Tag product page](https://claude.com/product/tag)
and [Claude Tag Help Center overview](https://support.claude.com/en/articles/15594475-what-is-claude-tag).

The official references were refreshed on 2026-08-13. Claude Tag currently
centers Slack channel mentions, direct messages and the assistant panel; shared
steering; workspace/channel memory; organization-owned identity and connected
tools; proactive standing work; organization and per-channel spend limits with
threshold alerts; and organization-wide task/network-call audit.

## Current Matrix

| Product behavior | MaxTag evidence | Status |
| --- | --- | --- |
| One workspace agent | Workspace identity, instructions, executor, tool grants, and network policy resolve before every project run; channel overlays can append/replace instructions and inherit/extend/replace tools and network access | Implemented |
| Per-project specialization | Identity and capability inheritance can be changed independently per project | Implemented |
| Channel Skills and instructions | Workspace Skills provide a mandatory baseline while projects and channels add reusable procedures. Only enabled summaries enter the prompt; `skills_list` and `skills_load` fetch current bodies on demand through a read-only route-bound broker. Shared enablement is rechecked across Server/Worker, and Skill text cannot widen access. Channel instruction append/replace remains independent. | Implemented locally; real Lark Skill invocation proof pending |
| Delegated specialists | Workspace, project, and channel policies add installation-managed Agent definitions to the route. The parent discovers enabled summaries and can synchronously invoke a focused child or create/cancel a durable asynchronous task after exact approval. Shared Server/Worker claims, retries, route/revision/access revalidation, cross-process cancellation, credential filtering, usage, and deterministic main-Agent continuation back into the original thread are implemented. A child has its own prompt and executor/model but no transcript, provider session, recursion, direct publishing, artifacts, write grants, or memory writes. Skills, Sources, read-only tool kinds, memory scopes, and network hosts remain intersections of the parent route. Invocation lifecycle and child tools remain linked in Activity and Web Assistant; the Agents console exposes recent async task results and Stop. | Implemented locally; real Lark invocation and async completion proof pending |
| Shared vs isolated memory | Workspace, project, channel, and thread documents have independent keys and grants; private channels keep read-only workspace context, isolated projects omit workspace context, and DMs remain thread-only. Workspace keep/custom retention defaults and project inherit/keep/custom overrides apply at commit or approval without rewriting existing facts. Fast search is route-bound. On every normal turn, a low-cost runner selects references only from that authorized snapshot; the host validates current document/version/line identities and supplies original text to the project agent, with a bounded local timeout fallback. The same runner provides one-shot semantic query and complete-thread synthesis into confidence-filtered, version-bound proposals that always require approval. Successful runs also enter a durable debounced wrapup queue with per-thread cursors, retry/recovery, oldest-first long-thread continuation, and bounded job retention. | Implemented locally |
| Lark group/topic continuity | Configured group routing plus established topic continuation without repeated mentions. A real MaxTag root event without `thread_id` and its later reply carrying `omt + root_id` now canonicalize to the same MaxTag thread. | Live proven |
| Existing-topic context | First Lark activation of an existing topic imports up to 50 source messages from the Lark thread history API and de-duplicates them from run/live transcript entries | Implemented locally |
| Long-topic continuity | Codex and Claude provider sessions resume per platform/workspace/project/thread. Codex supports explicit, automatic, proactive, and overflow-triggered native same-thread compaction; a guarded continuation does not replay the original user message. Missing sessions and failed native recovery reset only that topic and retry once from bounded durable context. | Implemented locally; live long-topic Lark proof pending |
| Real-time follow-ups | Claude active `stream-json` and Codex app-server `turn/steer` accept authorized same-topic follow-ups. Codex uses the exact active turn ID; rejected or raced input stays durable for the next turn, and cancellation sends `turn/interrupt` for that turn. An authorized MaxTag follow-up reached the active Codex turn before a human takeover. | Live proven |
| Visible long-running work | Progress cards, checklists, durable run queue, receipt-bound authorized Stop and Take over actions, follow-ups, artifacts, and delivery ledger. Take over records the acting Lark member, stops the exact run and queued steering, and posts a handoff in the original topic. Activity groups runs by workspace/project/thread and exposes request/output, invocation-scoped delegated-Agent traces, ordinary tools, usage, controls, timeline, and grouped delivery receipts. Web Assistant receives resumable server-pushed text/progress/tool/delegation events from the same durable timeline, renders sanitized GFM, and restores collapsible nested evidence after refresh. A live MaxTag run proved same-topic steering, receipt-bound actor authorization, cancellation, terminal card update, original-topic handoff, and organization audit with zero bridge failures. | Live Stop and Take over proven |
| In-channel capability status | Authorized members can use `/status`, `/maxtag status`, or bilingual “what can you access?” questions to inspect the exact current route, identity, actor role/capabilities, memory read/write boundary, enabled Skills/Agents/Sources/tools, network mode, standing work, and next-model-run budget state. The shared Server/Worker command uses no model allowance, remains available after budget exhaustion, records durable audit evidence, and excludes disabled or sibling-project resources. On 2026-08-14 a real private-group `/status` completed through `thread-status`, delivered once to the resolved topic, created no model usage record, and produced the redacted organization audit summary `Thread capability status inspected`. | Live proven |
| Proactive work | Scheduled routines and event-triggered workflow DAGs enter the same policy and run pipeline. Project agents can list current-thread triggers and propose one-time, interval, or daily follow-ups through the broker; create/pause/resume/delete require exact-argument approval. Project-scoped Lark Docx watchers recheck current read grants, establish a non-firing baseline, and emit deduplicated revision events with bounded content. Workflow operators can durably cancel an execution or retry one failed node with a distinct attempt run, old-run preservation, late-result fencing, dependency-aware descendant reset, and audit evidence. One-time work disables atomically after its only scheduled execution. Every result / Failures only / Silent policy supports thresholded one-shot failure escalation, recovery notice, retry, idempotent delivery receipts, and route/policy invalidation; quiet runs keep usage/history/governance evidence without ordinary progress/result chatter. Topic commands, broker tools, and Admin expose bounded latest status/results without carrying execution or incident history across a changed topic route. A real 3076/3080 MaxTag preflight proves transport, bridge, route, and scheduler visibility without sending; generated follow-up and document-change delivery await explicit live-send approval. | Implemented locally; live delivery pending |
| Spend governance | Workspace and project aggregate caps stack with inherited or custom per-channel caps, so a channel override cannot bypass a parent hard limit. New channels inherit a workspace/project default. The gate declines work before execution, the durable ledger records provider-reported runs/cost/tokens, and the Spend console breaks usage down by project, channel, and project-agent versus Luna retrieval/query/analysis/wrapup purpose. Memory-runner calls contribute cost without inflating user-run allowances. Idempotent 75%/95% threshold alerts appear immediately after a run or policy reduction. | Implemented locally |
| Organization audit | A role-gated Audit console and `/v1/audit` merge task lifecycle, brokered and provider-native tool calls, policy, access, binding, routine, and workflow evidence under workspace isolation with project/actor/action/category/outcome/destination filters and safe CSV export. Brokered HTTPS, GitHub, Lark, and external stdio MCP results record only normalized origin or logical connector boundary; paths, queries, user info, command text, arguments, results, and credentials are omitted. Deployment-level process/container egress telemetry remains missing. | Partial |
| Guarded external writes | Project-root file writes, direct commands, GitHub issue/comment, Lark document append, Base record create/update, and registered MCP writes use inherited workspace/project/channel policy. MaxTag persists schema-validated exact arguments and a digest, supports receipt-bound Lark or role-gated Activity decisions, rechecks grants and file preconditions at execution, atomically claims one execution, expires stale requests, and never auto-replays an unknown outcome. Commands require an explicit executable allowlist and always require approval. A successful action schedules one deduplicated same-thread continuation so the agent verifies and finishes the original request. Codex is native read-only with web search disabled; Claude exposes native Read/Glob/Grep only; network fetch is brokered through public-DNS and per-redirect route checks. | Implemented locally |
| Multi-client core | Native Lark, Telegram, Slack, GitHub, and Web Assistant clients share routing, policy, memory, run, and delivery contracts. Slack remains compatibility-only. Web Assistant adds authenticated project conversations, restart-safe transcript continuity, uploads, artifacts, Stop, and cursor-resumable SSE with sanitized tool evidence. | Implemented locally; Lark is the only primary chat-product parity surface |
| Self-service channel connection | Expiring single-use pairing invitations bind a chat or repository to a project, optional actor allowlists prevent forwarded-code misuse, binding audit records preserve actor/reason before-after evidence, and operators can dry-run/apply binding imports or export configured routes | Implemented locally |
| Secure Lark ingress contract | P2P and private-group messages use the supervised local long-connection bridge route `im.message.receive_v1`; interactive cards use the public authenticated callback because the installed Lark event CLI does not expose card actions as a long-connection EventKey. Callback secrets are encrypted in the managed Bot credential, and long-connection mode accepts URL verification/card actions while ignoring duplicate message callbacks. At startup and periodically while connected, the bridge scans every bound channel from an independent durable checkpoint, includes known/discovered topic replies, and replays messages through the same idempotent route/access/run pipeline without posting recovery chatter. Successful channels advance independently; partial or capped scans retain only the affected checkpoint and alert. Raw-body signature verification, AES-256-CBC decryption, encrypted URL challenge, v1/v2 token handling, replay window, and event/message-id deduplication remain implemented locally. | Partial; live card callback and disconnect/backfill proof pending |
| Supervised runtime | Four-process systemd target, Prometheus metrics and alerts, lease heartbeat, graceful requeue, progress-surface reuse, publish fencing, and real replacement-worker restart smoke | Implemented locally |
| Production Lark proof | Real MaxTag P2P and private-group messages passed through long-connection ingress into real Codex provider sessions; authoritative workspace/project/channel/root/topic/visibility reply, progress-card create/update, final text reply, inbound processing, persisted group/project routing, private chat metadata read, P2P history readback, native file/image delivery, and receipt-bound Stop cancellation passed. The Stop smoke recorded two processed card events, `cancel_requested`, terminal `cancelled`, and a delivered terminal card update. On 2026-08-13 a route-bound Source smoke used brokered `knowledge_search` and `knowledge_read` to recover an exact synthetic phrase with source/line citation, delivered it to the original MaxTag topic, and verified no route tools remained after disable. The same day Take over smoke proved root/reply canonicalization, real-time Codex steering, acting-member attribution, exact-card cancellation, terminal update, same-topic handoff, and organization audit with 11 passing checks. On 2026-08-14 a real private-group `/status` proved the zero-model control path, exact route and actor boundary, same-topic delivery, durable `thread_status` timeline, and redacted organization audit. A local server/bridge SIGTERM recovery preserved routing and restored both consumers to ready, while production systemd recovery remains open. Existing-topic history is blocked by missing group-message history scope; inbound resource download, delegated-Agent invocation, remote Source refresh/revision fencing, and operator deployment smoke remain. | Partial |
| Hosted identity and access | Installation owners can bootstrap, create, rotate, and revoke persistent owner/admin/viewer credentials with workspace scopes, one-time plaintext, digest-only storage, optimistic revisions, immediate Bearer/browser-session invalidation, last-owner protection, and Organization Audit evidence. Workspace terminal-run lifecycle adds read-only dry-run plus owner/CSRF/exact-workspace apply, latest-per-thread and cross-domain reference protection, atomic file/SQLite cleanup, and auditable deletion counts while preserving inbound dedupe, usage, source transcript, memory, and managed artifacts. SSO/OIDC, directory synchronization, hosted recovery, full-ledger deletion/export, high-volume normalized storage, and multi-host provider sessions remain. | Partial |
| Broader integrations | Deployment-approved external stdio MCP definitions now have installation-operator health/enable/disable controls, shared Server/Worker execution fences, optimistic revisions, safe audit, project exact-tool grants, and brokered write approval. Signed GitHub PR, issue, and Actions events, Alertmanager v4 notifications, and grant-checked Lark document revisions enter project-scoped workflows through durable producers. Slack is compatibility-only and has no parity roadmap; multi-host connector propagation, broader Lark document types, and future delete/close/merge operations remain. | Partial |

By functional shape, the local core now includes route-scoped on-demand Skills,
governed Knowledge Sources, and governed delegated Agents in addition to the prior matrix. Sources are workspace-owned revision/hash snapshots with additive workspace/project/channel assignment; workspace-bound automation principals provide idempotent ingest, bounded server-side text/HTML/PDF/DOCX extraction, and durable operator-triggered public-HTTPS refresh, while a durable Luna worker builds host-verified multilingual passage aliases and lexical fallback remains available. Only summaries enter the prompt and untrusted bodies remain behind bounded broker search/read tools. Real MaxTag retrieval, citation, delivery, and disable fencing are now production-proven. This is not production parity: the largest remaining
distance is operational proof and product administration, especially SSO or
directory-backed Agent Identity, hosted recovery, full-ledger deletion/export lifecycle,
  deployment-level egress telemetry, recursive child messaging, and reliable proactive
work on a supervised deployment. Governed scheduled Knowledge Source refresh is
implemented locally; remote revision-fencing evidence remains.

## Memory Contract

MaxTag's type name `global` means installation-level operator memory. It is not
silently injected into project runs.

Claude Tag documents workspace and channel memory. MaxTag adds `project` as a
client-neutral routing boundary so several Lark groups, Telegram or Slack chats,
or GitHub repositories can share one project policy without collapsing their
channel memory into one document.

| Conversation policy | Read | Write |
| --- | --- | --- |
| Public workspace-shared channel | workspace, project, channel, thread | workspace, project, channel, thread |
| Private workspace-shared channel | workspace, project, channel, thread | project, channel, thread |
| Project-isolated channel | project, channel, thread | project, channel, thread |
| Direct message | thread | thread |

Workspace writes still require an identified active workspace member with a
non-guest role. Installation memory is managed through the authenticated
operator API and console. Run-end memory extraction is proposal-only even when
the executor has a write grant: declarations are removed from the user-visible
reply, unauthorized scopes and credential-like values are rejected, and an
operator must approve the proposal before it becomes a revision. Lexical search
is available through the operator API, brokered agent tool, and console without
cross-route discovery. Approved version-bound semantic aliases give old facts a
persisted cross-language/synonym recall path before Luna reranking; host recall
also uses weighted Chinese segmentation, bounded n-grams, and duplicate-fact
collapse. Aliases are line-hash validated, never injected as facts, and stay
within the authorized route. Per-turn model-assisted retrieval and
full-conversation synthesis are implemented locally. Luna may propose an
approval-gated merge of 2-8 exact facts in one current scope/version; the host
validates every selector and commits the result as one revision. Explicit
per-fact expiry is version/line/hash-bound,
audited, and removes expired facts from runtime context, lexical search, and
semantic retrieval without deleting immutable revisions. Workspace keep/custom
defaults and project inherit/keep/custom overrides apply to project, channel,
and thread writes at commit or approval time; explicit per-fact keep/expiry wins
and existing facts remain unchanged. Embedding/ANN scale for much larger corpora
remains future depth work. Retrieval, query, manual analysis, and automatic
wrapup calls are metered separately from the project agent.

## Spend Contract

MaxTag keeps aggregate and per-channel limits independent. A run can be subject
to a workspace cap, a project cap, and one effective channel cap at the same
time. `disabled` on a channel removes only its local/default channel cap; it
cannot disable workspace or project hard limits. New channels inherit the
workspace default unless the project supplies a different default.

The Spend console and `/v1/spend` use the same durable ledger as the pre-run
gate. Detail rows may be limited, but totals always scan the complete selected
month. Lowering a policy below current usage reconciles alerts immediately, and
the `(period, route, metric, threshold)` identity prevents duplicate 75%/95%
alerts across retries. Claude CLI cost and token fields and Codex token fields
are preserved when the provider reports them. MaxTag does not infer Codex cost
from unstable local pricing. Each successful memory retrieval, query, analysis,
and wrapup invocation has its own idempotency key and purpose total; those calls
record zero runs while their reported cost still contributes to aggregate caps.

## Audit Contract

The Audit console and `/v1/audit` present one workspace-isolated chronology for
agent run lifecycle, brokered tools, policy changes, access changes, route
bindings, routines, and workflows. Operators can filter by project, actor,
action, category, outcome, and time; `/v1/audit.csv` exports the same bounded
evidence. The consolidated surface stores status-level run summaries and tool
input field names, not agent reply text, tool argument values, result previews,
provider sessions, or executor snapshots.

This is task and brokered-network evidence, not universal process tracing.
GitHub, Lark, Base, public HTTPS fetches, project file changes, and allowlisted
commands made through MaxTag's tool broker are auditable. Codex is fixed to a
read-only sandbox with native web disabled; Claude exposes only native
Read/Glob/Grep. Brokered HTTPS results retain only the normalized origin, Lark
and GitHub use their deployment-configured origin, and stdio MCP uses a logical
`mcp+stdio://server-id` boundary rather than claiming visibility into that
server's downstream traffic. Full Claude Tag network-call parity still requires
deployment-level process destination telemetry and container egress enforcement
as defense in depth around approved commands and the host process.

Brokered Lark and GitHub calls now carry two distinct identities: the route's
agent persona and the installation-managed credential identity that actually
authorizes the provider request. Credential definitions contain environment
references, never secret values. Workspace/project/channel grants can bind one
exact provider-matching identity; Server and Worker re-resolve it for every
call. Organization Audit records the credential identity ID, revision, external
actor, and normalized destination. Approved writes are revision-fenced, so an
identity rotation or edit requires a fresh approval before external execution.

## Product Scope

MaxTag's parity target is Claude Tag's shared collaboration experience rebuilt
for Lark groups, topic threads, and direct messages. Slack remains an existing
compatibility adapter, not a feature roadmap. GitHub, browser, and MCP remain
important as tools selected for the Lark Agent; they are not alternate primary
chat products for this parity milestone.

## Next Proof Gate

The live Lark proof now covers P2P and private-group long-connection receive,
real Codex execution, progress-card create/update, final text delivery,
persisted project routing, chat metadata, and P2P history readback. The next
parity proof gate, driven by `npm run smoke:lark` and `npm run bridge:lark`, is
a controlled MaxTag disconnect: send a message while the bridge is offline,
restart it, and prove that the missed message produces exactly one routed run
and reply without recovery chatter. This requires the Lark message-history
authorization. Inbound resource download, memory isolation, steering,
production supervisor recovery, long-topic context recovery, and one routine
still need end-to-end recorded evidence. MaxTag Stop is now live-proven: the
bridge received and delivered two `card.action.trigger` events with zero
failures, the first event requested cancellation for the receipt-bound run, the
second was handled idempotently, and the original progress card reached a
terminal `cancelled` state. Webhook callback verification remains a separate
compatibility proof when that ingress mode is selected.

Spend Control, Organization Audit, the version-bound semantic alias index,
per-fact and default memory retention, and per-purpose Luna usage are locally
verified as part of the current full regression suite, operator
admin/viewer authorization tests, secret scan, and desktop/mobile browser QA.
The live Development Workspace ledger reports 10 August runs, including five
for MaxTag, while historical records have no provider cost receipt and therefore
correctly remain `$0` with `0/10` cost coverage. A real Lark over-limit denial
and threshold-notification smoke remains an explicit launch proof gate.

Organization Audit is additionally covered by workspace-scoped operator/viewer
authorization, cross-workspace denial, filtered JSON and CSV tests, lifecycle
apply evidence, and desktop/mobile browser QA. Live Lark traffic already appears
as status-only task evidence. Terminal-run retention is implemented locally;
inbound/usage/source/memory/artifact deletion policy and deployment-level egress
enforcement remain launch gaps.
