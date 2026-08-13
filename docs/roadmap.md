# MaxTag Roadmap

## Phase 0: Repo Foundation

- Platform-neutral core contracts.
- Lark adapter shell.
- Executor abstraction for Codex and Claude.
- Platform-neutral progress card model with Lark as the primary product surface;
  existing Slack rendering remains compatibility-only.
- Selectable Lark delivery transport: memory dry-run locally, HTTP OpenAPI for
  real app bots.
- SQLite-backed global/workspace/project/channel/thread memory documents with
  transactional cross-process writes, immutable actor-attributed revisions,
  legacy Markdown import, history, and restore.
- Separate low-cost semantic Memory Runner with route-scoped query, manual
  synthesis, confidence-filtered version-bound proposals, and a durable
  background wrapup queue with per-thread cursors, retry/recovery, oldest-first
  long-thread continuation, and bounded terminal-job retention.
- Host-verified per-turn memory retrieval through that low-cost runner: bounded
  candidates from the authorized route only, weighted Chinese/Latin lexical
  recall, query expansion, coverage scoring, bounded fact context,
  duplicate-fact collapse, exact document/version/line
  validation, original-text reconstruction, user-stop propagation, short
  timeout, and deterministic local fallback. A SQLite-backed semantic alias
  index is attached only through approved version-bound
  remember/replace/merge/index
  proposals, validates line hashes, migrates unchanged lines, invalidates stale
  lines, and affects candidate ranking without entering agent context. Optional
  embedding/ANN indexing remains a future scale optimization rather than a
  runtime trust boundary.
- Approval-gated semantic consolidation supports one version-bound `merge`
  proposal over 2-8 exact facts in one scope. Approval atomically removes all
  source entries, adds one compact fact, refreshes aliases and retention, and
  preserves one immutable revision with the complete selector list.
- Version/line/hash-bound per-fact memory expiry with full multi-line note
  coverage, operator set/clear audit, unchanged-line migration, and exclusion
  from runtime, lexical search, and semantic retrieval while immutable history
  remains available.
- Workspace keep/custom default memory retention and project inherit/keep/custom
  overrides, applied at direct commit or proposal approval across chat, broker,
  automatic-candidate, analysis, and wrapup writes without retroactively
  changing existing facts.
- Explicit scoped memory commands and admin API for remember, forget, show,
  history, and restore.
- SQLite WAL outbox, inbound event ledger, turn delivery tracker, and configured
  channel/project bindings, with transactional claims across server and worker.
- SQLite-backed Lark/Telegram/GitHub pairing invitations with short-lived single-use
  codes, hashed persistence, atomic project route creation, revocation, and
  cascading chat unbind; existing JSON state imports on first startup.
- SQLite-backed workspace members, stable cross-client identity links,
  open/workspace/members project access modes, project roles, and capability
  checks on every external client ingress.
- Outbox recovery controls for stale `sending` records and scoped cancellation.
- SQLite WAL agent run ledger with status, cancel request, timeline events, and
  restart-safe cross-process claims.
- Durable run queue with inline worker claim, startup stale recovery, and manual
  worker/recovery API controls.
- Durable same-thread steering mailbox with atomic create-or-steer arbitration,
  executor live-input contract, ordered next-turn fallback, shared-thread stop
  commands, and cross-process cancellation polling.
- Native Codex app-server context compaction with `/compact`, automatic
  lifecycle evidence, configurable near-limit compaction, guarded same-thread
  overflow continuation, and bounded durable transcript fallback.
- Receipt-bound Lark progress-card Stop and Take over actions with v2 callback
  normalization, project actor authorization, run-scoped cancellation, durable
  human handoff evidence in the original topic, terminal control removal, and
  callback idempotency. Real MaxTag evidence now covers root/reply thread
  canonicalization, live Codex steering before takeover, exact card receipt,
  acting member, terminal update, same-topic handoff, and organization audit.
- Standalone worker process that can claim the shared run queue while HTTP
  ingestion runs with `OPENTAG_AGENT_WORKER=manual`.
- Prometheus endpoints for server, Lark bridge, worker, and scheduler with
  low-cardinality process, loop, queue, oldest-status, lease, routine, workflow,
  and long-connection consumer metrics; loopback listener controls, Bearer
  authentication, scrape config, and alerts.
- Owner-fenced run lease heartbeat, graceful SIGTERM requeue, replacement-worker
  progress-surface reuse, final publish fencing, concurrent SQLite cold-start
  retry, and systemd server/Lark bridge/worker/scheduler units with real
  process/restart tests.
- Generic client ingress that maps non-Lark envelopes into the same run queue,
  memory scopes, and tracked text delivery.
- Native Telegram Bot API webhook/send/edit adapter with forum-topic routing,
  update idempotency, managed inbound downloads, outgoing files, and tracked
  delivery.
- Native GitHub `issue_comment` webhook/create/update adapter with repository
  pairing, issue/PR thread routing, HMAC-SHA256 validation, idempotency,
  self-loop suppression, chunked replies, and tracked delivery.
- Content-addressed inbound attachment storage isolated by workspace, project,
  thread, and message; generic base64 upload rejects host path injection.
- Managed CLI artifact declarations with traversal/symlink/size validation,
  durable run events, native Lark/Telegram delivery, and authenticated
  integrity-checked Activity downloads.
- Shared file-backed workspace/project agent policy with workspace identity,
  executor, tool, and network defaults; explicit project identity/capability
  overrides; workspace-shared vs isolated project memory; monthly run/cost
  stacked workspace/project aggregate budgets, inherited/default/custom channel
  budgets, and audit.
- Budget gates run before executor work starts, record provider-reported usage in
  the durable ledger, expose full-month workspace/project/channel analytics and
  a role-gated Spend console, emit idempotent 75%/95% alerts after usage or
  policy changes, and leave `usage_budget_denied` / `usage_recorded` /
  `usage_threshold_alert` timeline evidence. Project-agent and low-cost memory
  retrieval/query/analysis/wrapup calls have separate purpose totals; memory
  runners add reported tokens and cost with zero user runs.
- Workspace-isolated Organization Audit merges task lifecycle, brokered tool,
  policy, access, binding, routine, and workflow evidence behind operator roles;
  JSON and CSV filters expose safe status summaries and tool input field names,
  not reply bodies, argument values, provider sessions, or result previews.
- Opt-in local Codex and Claude CLI execution with bounded output, process-group
  cancellation, timeout, project workspace resolution, and filtered child env.
- SQLite WAL-backed workspace/project routines with one-time, interval, and daily
  schedules, atomic cross-process claims, stale reclaim, manual triggers, audit
  history, deterministic bridging into the shared agent run queue, and
  inline/external/manual scheduler modes. One-time work atomically disables
  after staging its only execution. Lark and Telegram topics can create, list,
  pause, resume, and delete scoped standing work with requester audit. Project
  agents can use brokered list/create/pause/resume/delete tools; lifecycle writes
  are exact-argument approvals and are rechecked against the current thread.
- SQLite WAL-backed project workflow DAGs with immutable execution snapshots,
  manual and typed-event triggers, event-id deduplication, atomic node claims,
  dependency failure propagation, and deterministic shared-run-queue bridging.
- Durable native Alertmanager producer routes with immutable project scope,
  bearer-only ingress, bounded webhook-v4 evidence, firing/resolved events,
  state-based deduplication, operator audit, Admin controls, and route metrics.
- Operator console organized around projects, access, routines, workflows, activity,
  scoped memory, delivery, and project-aware agent previews.
- Optional operator authentication with Bearer automation, signed HttpOnly
  browser sessions, named multi-token principals, workspace-scoped collection
  and object authorization, owner/admin/viewer roles, authoritative audit actor,
  mutation CSRF protection, and a separate generic-client ingress credential.
  Installation owners can now bootstrap, create, rotate, and revoke persistent
  credentials with one-time plaintext, digest-only storage, optimistic
  revisions, immediate token/session invalidation, last-owner protection, and
  Organization Audit evidence.
- Per-run MCP tool broker with schema validation, scoped memory tools, approved
  GitHub reads, approved Lark Docs/Base reads, host-side credentials, and durable
  call/result audit. Deployment-approved external MCP definitions now have an
  operator-managed enable/disable and health-check lifecycle, cross-process
  state, optimistic revisions, safe audit, and project-level tool assignment;
  arbitrary command or secret entry remains outside the control plane.

## Phase 1: Lark Tag MVP

- Add finer-grained operator capabilities and optional SSO/OIDC or directory
  synchronization on top of the implemented persistent credential lifecycle.
- Binding audit records now cover configured routes, updates, self-service
  pairing connections, and cascade unbind with actor/reason before-after
  evidence; pairing invitations can restrict allowed consumer actor IDs; binding
  export plus dry-run/applied import are implemented around the transactional
  pairing and binding operation.
- Prefer Lark long-connection ingress for Feishu/Lark production apps. Keep the
  implemented webhook raw-body signature verification, AES-256-CBC event
  decryption, v1/v2 token checks, replay window, and event-id deduplication
  covered by protocol-vector and HTTP endpoint tests for webhook-mode
  deployments.
- Extend rich-post extraction beyond the implemented text, file, image, audio,
  video, mention, and topic/thread normalization.
- Keep the implemented `SourceThread` binding and Lark existing-topic history
  import covered by local hydration tests and live Lark smoke evidence.
- Use `scripts/lark-smoke.mjs` as the recurring Lark evidence harness for
  tenant-token readiness, long-connection event receive, bot delivery,
  progress-card patching, thread-history visibility, and artifact upload.
- Require mention for the first handled group topic by default, then allow
  follow-up messages in the established topic without repeating the mention.
- Resolve workspace and project identity before every run.
- Support `remember`/`forget` commands for granted workspace, project, and
  thread memory without invoking the full executor; keep installation memory on
  the operator control plane.
- Keep the implemented live progress cards, receipt-bound Stop action, and final
  state covered by card rendering and real subprocess cancellation tests.
- Send text replies and interactive progress cards through a real Lark app bot
  once credentials and scopes are configured.
- Short-circuit duplicate Lark events by `event_id` or message id.
- Keep the implemented workspace terminal-run lifecycle covered by dry-run,
  owner/CSRF/workspace confirmation, cross-store visibility, reference-closure,
  and Organization Audit tests. It atomically removes old terminal run events,
  delivered outbound records, terminal steering, invalidated sessions, terminal
  wrapups, and terminal approvals while protecting active or externally
  referenced runs plus the latest per thread. Inbound dedupe, usage ledgers,
  source messages, memory, and managed artifacts remain preserved. Add separate
  retention/export policies for those ledgers before claiming complete hosted
  deletion lifecycle. Queue depth and oldest-status metrics are implemented.
- Keep workspace/project memory approval gates covered by ingress/worker tests.
  Scoped memory export, revision diffs, protected dry-run/applied compaction,
  operator-approved proposal queues, and console policy/review controls are
  implemented.
- Queue accepted Lark events quickly, then execute runs through the shared worker
  path. A supervised local long-connection consumer bridge converts
  `lark-cli event consume` output into MaxTag client events and Lark
  progress-card actions alongside the other supervised MaxTag processes. The
  bridge now silently scans each bound channel from an independent durable
  checkpoint after startup and periodically while connected; recovered root
  and topic messages pass through the same message-id idempotency, routing,
  actor authorization, mention, budget, and run queue path. Partial channels
  retain their own cursor and alert without blocking healthy project channels.
- Keep operator recovery scoped to a run, thread, workspace, project, target, or
  kind so one noisy topic can be stopped without disrupting other projects.
- Keep the Lark implementation behind `PlatformAdapter`; do not let Lark field
  names leak into core tables or executor prompts.
- Keep the implemented Spend UI/API, stacked caps, inherited channel defaults,
  full-month analytics, per-purpose memory-runner metering, and 75%/95% alerts
  covered by server/worker tests. Add provider-specific Codex price mapping and
  real Lark denial/alert smoke evidence.
- Keep the implemented Organization Audit UI/API covered by workspace isolation,
  actor/category/outcome/destination filters, safe export tests, and retention
  limits. Brokered HTTPS, GitHub, Lark, and stdio MCP now retain only normalized
  origins or logical connector boundaries. Add deployment-level process
  destination telemetry and container egress enforcement before claiming
  complete per-request network-call audit. Provider-native mutation, command,
  and web tools are already disabled.

## Phase 2: Agent Runs

- Harden Codex and Claude local CLI execution behind the common `Executor`
  contract with provider event parsing and runtime evidence.
- Keep the implemented systemd supervisor/deployment manifests, metrics, alerts,
  lease heartbeat, graceful requeue, and restart smoke covered by process tests.
- Keep true mid-turn Codex app-server `turn/steer` and Claude `stream-json`
  follow-ups covered by completion-race, exact-turn cancellation, and durable
  fallback tests. Both CLI adapters resume provider sessions with durable
  transcript recovery. Missing
  provider state and context-window exhaustion invalidate only the current
  scoped topic session and rebuild once from bounded durable context.
- Add hosted interactive reports and first-class PR/link artifact producers on
  top of the implemented managed file/report/chart/patch path.
- Add instruction-level resumable execution checkpoints. Lease heartbeat,
  provider-session/transcript recovery, progress-surface reuse, and restart
  replay are implemented; a replacement may still restart the current provider
  turn when no provider resume point exists.

## Phase 3: Access Bundles

- Installation-managed Agent Identities are implemented for Lark and GitHub
  tool credentials. Workspace/project/channel grants bind an optional exact
  identity, while existing deployments receive stable built-in identities for
  the current Lark app and GitHub token. Stored definitions contain environment
  references only. Server and standalone Worker resolve the same shared
  catalog, reject missing/disabled/provider-mismatched identities before
  network access, record agent identity, credential identity revision, external
  actor, and normalized destination, and invalidate an approved write if its
  identity revision changes before execution.

- Route-scoped Skills are implemented as an installation-managed reusable
  procedure catalog with optimistic revisions, audit, shared Server/Worker
  enable fencing, workspace baseline plus project/channel additions, summary-
  only prompt discovery, and read-only on-demand body loading.
- Governed delegated Agents are implemented as installation-managed specialist
  definitions with workspace/project/channel assignment, summary-only parent
  discovery, synchronous `agent_invoke`, and approval-gated durable
  `agent_task_create` / `agent_task_cancel` plus read-only `agent_tasks_list`.
  Async tasks use an atomic cross-process claim/retry/cancel ledger, revalidate
  route assignment, Agent revision, and the approved access ceiling, then
  schedule one deterministic main-Agent continuation in the original thread.
  A child receives only the definition-selected intersection of parent read
  grants, memory, network, Knowledge Sources, and Skill IDs, with no transcript,
  session, recursion, direct publishing, artifacts, or memory writes. Add real
  Lark invocation and completion-continuation proof; direct child messaging is
  still intentionally absent until a concrete shared-workflow need appears.
- Delegated invocation traces are implemented across the durable timeline,
  Activity, and Web Assistant. Every invocation owns its lifecycle, bounded
  task/result preview, usage, and child tool rows; repeated calls to the same
  Agent remain separate. The Assistant projection allowlists these fields and
  excludes definitions, full tool arguments/results, and provider-private data.
- Governed Knowledge Sources are implemented as workspace-owned text/file/URL
  snapshots with SHA-256 identity, optimistic revisions, credential rejection,
  workspace/project/channel additive assignment, summary-only prompt discovery,
  bounded lexical passage search, line-addressed reads, cross-process disable
  fencing, owner-only content management, and organization audit. Workspace-
  bound Bearer principals now provide idempotent automated ingest and safe job
  status. Every source revision enters a durable claim/retry queue; a dedicated
  Luna runner emits host-verified, revision-bound line passages and multilingual
  aliases that augment lexical retrieval without exposing model text to the
  primary Agent. Server-side UTF-8 text, HTML, PDF, and DOCX extraction now
  records bounded provenance. URL Sources have durable operator-triggered
  public-HTTPS refresh with conditional requests, retry/recovery, revision
  fencing, metrics, and alerts. Governed hourly, six-hour, daily, and weekly
  schedules discover due Sources and enqueue once across Server/Worker, expose
  the next refresh time in Admin, and retain the same URL/revision safety
  boundary. Real MaxTag route-bound search/read, cited reply delivery, and
  post-disable access fencing passed on 2026-08-13. Add live remote-refresh/revision-fencing evidence, and
  embedding/ANN scale only if corpus evidence requires it.

- Extend project grants to optional channel/thread overrides; project resource
  allowlists are implemented.
- Add GitHub App installation token exchange on top of the implemented host-side
  token provider.
- Extend the implemented one-time exact-argument approval state machine for
  GitHub issue/comment, Lark document append, and Base record create/update to
  future close, merge, delete, and other destructive operations. Current writes
  are durable, policy-inherited, receipt-bound in Lark, and atomically claimed;
  uncertain post-call crashes fail closed without automatic replay.
- Add supervised multi-host propagation and destination telemetry beyond the
  implemented single-data-directory external MCP lifecycle. The current control
  plane preserves deployment-only commands, environment secret references,
  cross-process enable fences, project tool grants, remote schema checks, drift
  fail-closed behavior, and exact write approval.
- Add container-level egress enforcement and destination telemetry as defense
  in depth beyond the brokered public-HTTPS host/DNS/redirect checks. Provider
  mutation, command, and web tools are disabled; native read-only evidence stays
  redacted.

## Phase 4: Proactivity

- Routine foundation: scheduled summaries, channel digests, and recurring checks
  can run through the shared executor and delivery path; each thread has a
  bilingual standing-work command surface plus project-granted agent tools for
  one-time and recurring follow-ups.
- Workflow foundation: saved agent DAGs can run manually or from authenticated,
  idempotent typed events; intermediate nodes remain internal and sink nodes
  publish only through an explicit same-project client binding.
- Run the implemented supervised scheduler, queue/lease metrics, and alerts in a
  live Lark deployment and capture external delivery/restart smoke evidence.
  The reusable `smoke:lark-routine` gate and its non-mutating real MaxTag
  preflight are implemented; the current development instance is intentionally
  manual, and its generated live topic reply remains an explicit approval gate.
- Native watcher producers: signed GitHub PR, issue, and Actions workflow-run
  webhooks are implemented through configured repository bindings, bounded
  payloads, durable delivery-ID deduplication, typed event workflows, Admin
  event discovery, audit, and metrics. Alertmanager v4 firing/resolved routes
  are also implemented with bearer-only ingress, immutable project scope,
  bounded evidence, state deduplication, Admin lifecycle, audit, and metrics.
  Lark document revision monitors are implemented with current-grant checks,
  baseline-without-fire behavior, bounded raw content, atomic cross-process
  claims, failure backoff, and deterministic event deduplication. Add Sheets,
  Base, Drive, and broader channel activity producers.
- Durable workflow execution cancellation and failed-node retry are implemented
  in SQLite/file stores, API, Admin, and audit. Retry preserves earlier attempt
  runs, fences late results, and resets only descendants skipped by that failure.
  Add branching/parallel graph editing and per-workflow queue metrics without
  allowing arbitrary in-process scripts.
- Richer routine status and bounded recent-result summaries are implemented in
  topic commands, brokered tools, and Admin with execution-snapshot route
  validation. Configurable Every result / Failures only / Silent delivery,
  thresholded one-shot failure escalation, recovery notices, bounded retry,
  delivery-receipt idempotency, and route/policy invalidation are implemented.
  Add a live document-change plus failure/recovery notification smoke after the
  existing explicit MaxTag send gate is approved.

## Phase 5: Multi-Platform

- Product focus is Lark-first: parity means reproducing Claude Tag's shared
  Slack experience in Lark groups, topics, and direct messages. Slack remains
  compatibility-only and receives no new product investment; GitHub, browser,
  and MCP are tools used by the Lark Agent rather than competing primary chat
  surfaces.

- Keep native platform webhooks thin by mapping them into `/v1/client/events`.
- The authenticated Web Assistant now acts as a durable native client with
  project-scoped conversations, shared memory/runtime policy, managed uploads,
  artifacts, and Stop. Cursor-resumable SSE now pushes Claude text deltas,
  executor progress, terminal state, and sanitized tool evidence from the
  durable timeline across standalone worker/server boundaries. Local
  `marked` plus DOMPurify rendering supports allowlisted GFM, and the sanitized
  snapshot restores per-run collapsible progress/tool/delegated-Agent traces.
  Add syntax highlighting, general recursive team traces, search, browser notifications,
  and installable PWA depth without forking the runtime contract.
- Run live Telegram webhook/download/delivery smoke tests for the implemented
  native file pipeline.
- Run live GitHub webhook/comment create/update and permission smoke tests for
  the implemented native issue/PR comment client.
- Keep the existing Slack adapter regression-tested for compatibility, without
  expanding its product surface or making Slack smoke a launch gate.
