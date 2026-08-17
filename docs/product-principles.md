# Product Principles

1. Work happens in shared threads.
2. The agent is visible while working: progress should be a checklist, not a
   silent wait.
3. Every project gets an isolated execution sandbox. Tools and credentials are
   granted to that sandbox by workspace/project policy, not guessed from the
   host shell.
4. Memory is scoped and correctable.
5. Artifacts are first-class: PRs, files, reports, charts, and links should have
   durable records.
6. Lark is the first surface, but MaxTag is not a Lark-only runtime.
7. The default posture is least privilege: deny tools and network paths until a
   grant exists.
8. MaxTag is a general-purpose agent, not a workflow dispatcher. Inside a
   granted project sandbox it should inspect, edit, execute, diagnose, retry,
   and verify autonomously. Skills, wrappers, routines, and workflows are
   optional accelerators.
9. Human approval protects boundary crossings (for example production changes,
   broader repositories/data, or additional credentials), not ordinary repair
   work already contained by the project sandbox.
