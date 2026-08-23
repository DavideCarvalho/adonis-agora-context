---
"@adonis-agora/context": patch
---

Ship TanStack Intent AI-agent skills with the package

The package now carries three agent skills under `skills/`, published inside
the npm tarball so coding agents (Claude Code, Cursor, Copilot, Codex…) can
discover them via `npx @tanstack/intent list` after install:

- **context-basics** — install/`node ace configure`, the server-stack
  middleware, reading/writing the store (`Context.traceId()` / `tenantId()` /
  `userRef()` / `set()`), module augmentation of `ContextStore`, testing
  helpers, and the lucid tenant-connection helper.
- **context-cross-process** — `serialize()` / `deserialize()` carrier
  snapshots, the two-line queue pattern, `bind()`, W3C baggage, traceparent
  helpers, and durable auto-propagation.
- **context-customization** — the five customization levels of `defineConfig`,
  enrichers/`Context.lazy`, process-global config + `resetConfig()`, and the
  `CONTEXT_ACCESSOR` / `CONTEXT_SET` / `CONTEXT_SCOPE` globalThis slots.

No runtime code changes — this only adds skill files, the `_artifacts/`
discovery documents, a skills-validation CI workflow, and dev tooling
(`@tanstack/intent` devDependency).
