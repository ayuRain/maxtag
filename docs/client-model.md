# Client Model

MaxTag treats Lark, Telegram, Slack, GitHub comments, Web Assistant, and future surfaces as
clients of the same thread-agent core.

## Core Objects

- `SourceThread`: the shared work context. Examples: Lark topic, Telegram chat,
  Slack thread, GitHub issue, GitHub pull request comment thread.
- `Workspace`: the installation-level boundary for one global bot.
- `Project`: the group/repo/team boundary that keeps memory and grants separate.
- `WorkspaceMember`: a person linked to stable identities from one or more
  clients.
- `ProjectMembership`: the project role used to authorize invocation, memory
  writes, and standing-work changes.
- `PlatformAdapter`: normalizes inbound events and renders outbound progress.
- `ProgressSurface`: the best available UI for that client. Lark uses cards;
  Telegram can use edited receipts; GitHub can use comments and checklists.
- `AccessBundle`: thread-level tool and credential grants, including explicit
  read/write permissions and resource allowlists.
- `OpenTagToolBroker`: a per-run capability endpoint that turns an access bundle
  into a filtered MCP tool list and durable call audit without giving service
  credentials to the executor.
- `ScopedMemorySnapshot`: only policy-granted installation, workspace, project,
  and thread memory, loaded in deterministic order.
- `MemoryDocument` and `MemoryRevision`: the current scoped snapshot plus an
  immutable SQLite history attributed to a trusted client or operator actor.
- `Executor`: Codex, Claude, or another agent runner.
- `Workflow`: a versioned project DAG whose nodes are durable agent runs and
  whose sink nodes publish through a client-neutral destination.
- `WorkflowProducerRoute`: an operator-owned mapping from one native producer
  endpoint to an immutable workspace/project scope.

## Current Status

- Lark: native callback adapter with progress cards, receipt-bound authorized
  Stop actions, and HTTP OpenAPI delivery.
- Telegram: native Bot API webhook adapter with forum-topic routing, editable
  progress messages, chunked replies, outgoing documents, and tracked delivery.
- GitHub: native `issue_comment` webhook adapter with repository-level project
  binding, issue/PR threads, editable progress comments, chunked replies,
  HMAC-SHA256 verification, self-loop suppression, and tracked delivery.
- Lark, Telegram, Slack, and GitHub share the same invitation model: an operator targets a
  workspace/project/client, then `/pair CODE` turns the consuming chat into a
  configured channel binding.
- Lark, Telegram, Slack, GitHub, and generic client events share the same actor authorization
  model after routing. Projects can be open, workspace-member-only, or
  project-member-only.
- Client-thread membership and operator access are separate trust planes.
  Named operator principals carry workspace scopes and owner/admin/viewer roles;
  authenticated principal identity, never a request-body actor string, owns
  control-plane audit records.
- A project inherits the workspace agent identity, executor, tool grants, and
  network policy unless it selects an explicit project override.
- Memory policy is separate from capability inheritance. Workspace-shared
  channels load workspace/project/channel/thread memory, isolated projects load
  project/channel/thread, private channels get read-only workspace context, and
  direct messages load thread memory only. Installation memory is control-plane
  only.
- Workspace memory writes also require an identified active non-guest workspace
  member; project/channel/thread writes follow project capability.
- Manual and typed-event workflows resolve the same project policy, executor,
  scoped memory, run queue, and client destination as an inbound conversation.
- Slack: signed Events API ingress for channel mentions and direct messages,
  stable `thread_ts` routing, editable progress, native replies/files, pairing,
  managed inbound attachments, and tracked delivery. A real installed-workspace
  smoke test remains a release gate.
- Web Assistant: operator-authenticated project conversations create durable
  `web` thread bindings, enter the same inbound ledger and worker queue, retain
  transcript/session continuity across restart, support managed uploads and
  artifacts, and expose the same Stop contract as chat clients. The browser
  consumes workspace-authorized SSE over the durable run timeline: global
  monotonic event cursors resume after disconnect, Claude text deltas and all
  executor progress arrive without polling, and tool events expose only safe
  identity/status/duration fields. Assistant output uses a local allowlisted
  GFM renderer and keeps script, image, event-handler, and unsafe URL content
  out of the DOM. The same sanitized timeline restores collapsible run traces
  after a reload without returning historical text deltas.
- GitHub tools and GitHub as a source client are separate capabilities: the
  client adapter handles comments, while project grants govern repository and
  issue reads/writes inside an agent run.

The goal is not to clone AgentDock feature-for-feature. AgentDock is the mature
workbench; MaxTag is the shared-thread product layer that can reuse selected
AgentDock ideas behind a platform-neutral boundary.

## Routing Rule

Every inbound client event is normalized into the same sequence:

```text
client event -> SourceThread -> Workspace -> Project -> actor capability -> scoped memory -> Executor
```

For the default single-workspace Lark product, onboarding is intentionally
add-bot-and-mention: an administrator configures the Lark app, default project,
and executor once; a member then adds MaxTag to a group and mentions it. The
first accepted run persists an observed topic route to that default project.
Deployments that require explicit project selection can enable configured
binding mode and retain the pairing-code flow:

```text
pairing invitation -> client chat -> configured project binding -> SourceThread route
```

Lark groups/topics, Telegram chats/forum topics, Slack threads, GitHub
repositories/issues, and Web Assistant conversations now share this route.
Clients add adapters and surfaces, not new executor or memory concepts.

Standing work follows the same rule. A routine created in a Lark topic,
Telegram forum topic, or GitHub issue retains the resolved workspace, project,
destination, and requesting user, then re-enters the shared run queue when its
schedule is due.

Workflow events add no alternate execution plane:

```text
typed event -> workspace/project workflow -> ready DAG node -> agent run queue -> client sink
```

Intermediate nodes use an internal workflow thread, while sink nodes require a
configured destination binding in the same workspace and project. An event
producer retries safely with a stable event
ID; exact workspace, project, and event-type matching prevents cross-project
activation.

Native producers never choose workspace or project from webhook payload data.
The first GitHub producer family maps a signed repository webhook through its
configured `github` channel binding, emits bounded `github.pull_request.*`,
`github.issue.*`, or `github.workflow_run.*` events, and deduplicates on the
GitHub delivery ID. The normalized payload is untrusted workflow evidence, not
agent instructions.

Alertmanager maps a bearer-authenticated route ID through a durable
`WorkflowProducerRoute`, emits bounded `alertmanager.firing` or
`alertmanager.resolved` evidence, and deduplicates an exact normalized alert
state. The body cannot override the route's workspace or project. GitHub uses a
configured client binding because a repository is also a conversation source;
Alertmanager uses a producer route because it is ingress only, not an outbound
client.

Before a native adapter exists, a client can submit the normalized envelope to
`/v1/client/events`. The server records inbound idempotency, resolves bindings,
loads scoped memory, enqueues an agent run, and writes generic progress/text
receipts into the same delivery ledger.
