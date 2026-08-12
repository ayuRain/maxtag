# Claude Tag Parity

OpenTag follows the same product center as Claude Tag: one visible workspace bot
serves many team channels while keeping each channel's work controllable. It
does not copy Claude Tag's implementation or AgentDock's local-workbench object
model.

Reference behavior: [Claude Tag overview](https://claude.com/docs/claude-tag/overview),
[how it works](https://claude.com/docs/claude-tag/concepts/how-it-works),
[settings map](https://claude.com/docs/claude-tag/concepts/settings-map), and
[memory](https://claude.com/docs/claude-tag/users/memory).

## Current Matrix

| Product behavior | OpenTag evidence | Status |
| --- | --- | --- |
| One workspace agent | Workspace identity, instructions, executor, tool grants, and network policy resolve before every project run | Implemented |
| Per-project specialization | Identity and capability inheritance can be changed independently per project | Implemented |
| Shared vs isolated memory | Workspace-shared, project-isolated, private read-only workspace, and DM thread-only policies are enforced in ingress, runtime, and tool broker | Implemented |
| Lark group/topic continuity | Configured group routing plus established topic continuation without repeated mentions | Implemented locally |
| Visible long-running work | Progress cards, checklists, durable run queue, receipt-bound authorized Stop action, follow-ups, artifacts, and delivery ledger | Implemented locally |
| Proactive work | Scheduled routines and event-triggered workflow DAGs enter the same policy and run pipeline | Implemented locally |
| Multi-client core | Native Lark, Telegram, and GitHub clients share routing, policy, memory, run, and delivery contracts | Implemented locally |
| Self-service channel connection | Expiring single-use pairing invitations bind a chat or repository to a project | Implemented locally |
| Secure Lark callback contract | Raw-body signature verification, AES-256-CBC decryption, encrypted URL challenge, v1/v2 token handling, replay window, and event-id deduplication | Implemented locally |
| Production Lark proof | Real app scopes, live encrypted delivery, Stop callback, card patching, files, restart recovery, and operator deployment smoke | Not yet proven |
| Hosted identity and access | Credential lifecycle, SSO/OIDC, deployment manifests, metrics, retention, and multi-replica provider sessions | Gap |
| Broader integrations | Slack adapter, external MCP registry, watcher producers, and destructive-action approvals | Gap |

## Memory Contract

OpenTag's type name `global` means installation-level operator memory. It is not
silently injected into project runs.

| Conversation policy | Read | Write |
| --- | --- | --- |
| Public workspace-shared project | workspace, project, thread | workspace, project, thread |
| Private workspace-shared thread | workspace, project, thread | project, thread |
| Project-isolated channel | project, thread | project, thread |
| Direct message | thread | thread |

Workspace writes still require an identified active workspace member with a
non-guest role. Installation memory is managed through the authenticated
operator API and console.

## Next Proof Gate

The next parity milestone is not another local UI feature. It is a live Lark
deployment that proves callback verification, topic routing, progress-card
updates and Stop interaction, file delivery, memory isolation, steering, worker
restart recovery, and one routine end to end with recorded evidence.
