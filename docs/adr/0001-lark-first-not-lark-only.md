# ADR 0001: Lark First, Not Lark Only

## Status

Accepted.

## Context

The first target surface is Feishu/Lark because the expected users already work
there and Lark topic threads map well to the Claude Tag interaction model.
However, naming the project after Lark would make the architecture too narrow.

## Decision

The product and codebase use platform-neutral names:

- `SourceThread`, not `LarkThread`
- `PlatformAdapter`, not `LarkAdapter` as the only contract
- `ProgressSurface`, not `LarkCard`
- `AccessBundle`, not `LarkPermission`

The first concrete implementation lives in `packages/platform-lark`.

## Consequences

- Lark-specific code must stay inside the Lark package or server wiring.
- Core records store platform kind and external ids, not Lark-only fields.
- Telegram, Slack, GitHub issues, and Linear can be added without changing the
  core agent-run contract.

