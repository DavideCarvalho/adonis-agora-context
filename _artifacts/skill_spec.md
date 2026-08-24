# Skill spec — @adonis-agora/context

Autonomous compressed discovery (no maintainer interview — fully-autonomous
constraint). Everything below is grounded in README.md, DESIGN.md, docs/*.mdx
(all seven narrative files), and packages/core/src. Gaps are recorded in
`_artifacts/domain_map.yaml` and at the bottom of this file.

## Scope decision

Single-package library: the monorepo publishes exactly one client-facing
package, `@adonis-agora/context` (`packages/core`), whose subpath exports
(`/testing`, `/lucid`, `/context_provider`, `/context_middleware`, `/configure`)
ship inside it. Skills therefore target that one package and use the
minimal-library fast path from the tree-generator spec: **flat structure,
no router skill, every skill type `core`, each entry carrying its owning
package.**

## Skill set (flat; all type `core`; 3 skills)

Core package — `packages/core/skills/`:

1. `context-basics` — install + `node ace configure`, the server-stack
   middleware, `defineConfig`, reading/writing the store (`Context.traceId()` /
   `tenantId()` / `userRef()` / `get()` / `set()`), `ContextStore`/`UserRef`
   shape, module augmentation for custom fields, testing helpers
   (`runWithContext` / `enterContext`) and the lucid tenant-connection helper
   (`defineTenantConnections`).
2. `context-cross-process` — `serialize()` / `deserialize()`, the
   `ContextCarrier` snapshot semantics, the `@adonisjs/queue` two-line pattern,
   ace-command `Context.run`, `bind()`, W3C baggage (`toBaggage` /
   `fromBaggage` + codecs), traceparent helpers (`extractTraceparent`,
   `parseTraceparent`, `toTraceparent`), durable auto-propagation.
3. `context-customization` — the five customization levels in `defineConfig`
   (`traceId` / `initialize` / `enrichers` / `carrier` / `serialize` /
   `deserialize` / `baggage`), `Context.lazy`, `runEnrichers`,
   process-global config + `resetConfig()`, and the three `globalThis`
   ecosystem slots (`CONTEXT_ACCESSOR`, `CONTEXT_SET`, `CONTEXT_SCOPE`).

## Highest-value AI-agent guidance (what to get right)

- The middleware is registered on the **server** stack by the configure codemod
  and uses `enterWith` so the context survives the middleware return. Agents
  that "helpfully" move it to the named/router stack lose the context on routes
  where it must exist; agents wrapping `next()` in `Context.run` tear the store
  down before handlers execute.
- `Context.set('userRef', …)` outside an active context is a **silent no-op**
  plus a one-shot `console.warn` — auth stamping code that runs before the
  middleware (or on excluded routes) drops values without throwing.
- Accessors never throw; only `traceId` is required on an active store.
  `Context.deserialize(undefined, fn)` deliberately runs with no store rather
  than throwing, and synthesizes a fresh trace id when a carrier arrives
  without one.
- The carrier is a **dispatch-time snapshot**, not a live view — long-running
  workflows re-hydrate stale authority by design.
- Cross-boundary config is **process-global** and replaced wholesale by each
  `Context.configure()`; a second differing call warns. `app.container.swap`
  cannot change it (it lives outside the IoC container).
- A custom accessor must implement both `get()` forms; a no-arg-only accessor
  compiles but silently returns the whole store where consumer libs expect one
  field (the documented authz all-permissions-fail-closed incident).

## Remaining Gaps (interview substitutes)

- No maintainer interview ran; priority ordering of failure modes is inferred
  from doc Callouts and source comments.
- No GitHub issue mining performed this session; real-world frequencies unknown.
- Durable/AuthKit integration contracts live in sibling repos and were cited,
  not verified.
- Whether `database-per-tenant.mdx` deserves its own skill vs. coverage inside
  `context-basics` is a right-sizing judgment call made autonomously.
