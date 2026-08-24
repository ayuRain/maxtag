# ADR 0002: Project Runtime Is the Agent Boundary

- Status: Accepted
- Date: 2026-08-24

## Decision

MaxTag treats one Project as one durable Agent runtime.

- Every Lark group, topic, Web session, repository, or other bound client is
  only an entrance into the Project.
- The Project owns one provider conversation, one persistent workspace, one
  execution lane, scoped memory, and Project capabilities.
- Replies and progress cards always return to the source client thread for the
  individual turn.
- A follow-up in the same source thread may steer the active turn. A message
  from another group becomes a durable queued Project turn so output cannot
  leak into the wrong group.
- Control-plane commands such as status, routine management, and memory
  management remain thread-scoped and may execute without waiting for a long
  Project task.
- Generic Project requests run directly through the Project Agent. Workflows,
  skills, and wrappers are optional tools, not the dispatch model.

## Durability

- Provider session identifiers and run state are stored in SQLite WAL.
- Project workspaces and build cache are mounted on persistent volumes.
- Only one model run may own a Project runtime at a time, including across
  workers sharing the state store.
- Stale worker leases are requeued on startup; cancellation and steering are
  durable.
- If the provider session is missing or reaches its context boundary, MaxTag
  rebuilds it from the bounded, cross-group Project transcript and approved
  Project memory.

## Operational contract

- Exactly one active Lark consumer is allowed for a Bot installation.
- The control plane owns routing, policy, memory, audit, and UI surfaces.
- Project Runners own filesystem and command execution boundaries.
- Cards show acknowledgement, real progress/log evidence, and the result; they
  do not define a fixed workflow.

## Compatibility

`OPENTAG_EXECUTOR_SESSION_SCOPE=thread` restores the historical per-thread
provider-session boundary. Production defaults to `project`.
