---
name: context-customization
description: >-
  Customize @adonis-agora/context beyond defaults: the five levels in
  defineConfig — traceId / initialize hooks, enrichers[] and Context.lazy for
  derived fields, carrier: [...] and full serialize/deserialize overrides, the
  baggage key map (custom key or false) — plus Context.runEnrichers() outside
  HTTP, process-global Context.configure() / resetConfig(), and the three
  globalThis ecosystem slots CONTEXT_ACCESSOR (Symbol.for('@agora/context:accessor'),
  overloaded get()/get(key)), CONTEXT_SET (contextWriter.set(patch)) and
  CONTEXT_SCOPE (contextScope(snapshot, fn)). Use for "add a custom field to
  the context", "derive fields from tenantId", "change which fields cross the
  queue boundary", "swap what consumer libraries read", or "configure the
  context in a bare worker without the Adonis provider".
metadata:
  type: core
  library: "@adonis-agora/context"
  library_version: "0.6.0"
  framework: adonisjs
license: MIT
sources:
  - 'DavideCarvalho/adonis-context:docs/customization.mdx'
  - 'DavideCarvalho/adonis-context:docs/the-store.mdx'
  - 'DavideCarvalho/adonis-context:packages/core/src/define_config.ts'
  - 'DavideCarvalho/adonis-context:packages/core/src/context.ts'
  - 'DavideCarvalho/adonis-context:packages/core/src/accessor.ts'
  - 'DavideCarvalho/adonis-context:packages/core/src/writer.ts'
---

# @adonis-agora/context — customization levels & integration seams

`node ace configure` plus an empty `config/context.ts` fits most HTTP apps.
When it stops fitting, customization is organized as **five levels** — from
adding typed fields to swapping the accessor consumer libraries read. Levels 2
and 4 live entirely in `config/context.ts`, validated by `defineConfig`.

| Level | What you change | How | Default |
|-------|-----------------|-----|---------|
| 1 | Add your own fields | module augmentation of `ContextStore` | — |
| 2 | Populate fields / trace id | `traceId` / `initialize` / `enrichers` | `traceparent` header → random |
| 3 | Non-HTTP entrypoints | `Context.run` / `enterWith` (+ `configure`) | middleware on `server` stack |
| 4 | What survives cross-process | `carrier` / `serialize` / `deserialize` / `baggage` | `traceId` + `tenantId` + `userRef` |
| 5 | Swap the accessor libs read | overwrite the `globalThis` slot | `contextAccessor` |

## Setup

```ts
// config/context.ts — one file holds population AND cross-boundary options
import type { HttpContext } from '@adonisjs/core/http'
import { defineConfig } from '@adonis-agora/context'

export default defineConfig({
  // Level 2 — population (runs at the start of every request):
  initialize: (ctx) => ({ tenantId: ctx.request.header('x-tenant-id') }),
  // Level 4 — cross-boundary (pushed onto the singleton via Context.configure):
  carrier: ['traceId', 'tenantId', 'userRef'],
})
```

## Core patterns

### Pattern 1 — derived fields: eager `enrichers` vs lazy `Context.lazy`

Enrichers run right after the middleware enters the context. Each may return a
partial to merge **or** mutate the store in place; a throwing enricher is
isolated from the rest.

```ts
export default defineConfig({
  enrichers: [
    // Return a partial → merged into the store:
    (store) => ({ region: regionForTenant(store.tenantId) }),
    // Or write onto the store directly:
    (store) => {
      store.region = regionForTenant(store.tenantId)
    },
  ],
})
```

The second parameter (`req`) is typed **unknown**: the middleware passes the
AdonisJS `HttpContext`, but a worker calling `Context.runEnrichers(job)` passes
whatever it hands over. Narrow before reading headers:

```ts
import type { HttpContext } from '@adonisjs/core/http'

enrichers: [
  (store, req) => {
    const ctx = req as HttpContext | undefined
    const region = ctx?.request.header('x-region')
    if (region) store.region = region
  },
]
```

For expensive values compute on first access instead — memoized per store per
key:

```ts
const name = Context.lazy('displayName', (s) => lookupName(s.userRef))
```

Outside HTTP, enrichers do not run by themselves — call them after entering the
store (`runEnrichers` is a safe no-op with no context/enrichers):

```ts
await Context.run({ traceId: randomTraceId(), tenantId: 'acme' }, async () => {
  Context.runEnrichers(job) // forwarded as the `req` argument
  await rebuildReport()
})
```

Source: `docs/customization.mdx` (Level 2 + running enrichers outside HTTP),
`packages/core/src/context.ts` (`lazy`, `runEnrichers`).

### Pattern 2 — choose what crosses the boundary

List extra fields on the default carrier, or take both directions wholesale:

```ts
export default defineConfig({
  carrier: ['traceId', 'tenantId', 'userRef', 'locale'], // opt a custom field in

  // Or override both directions completely:
  serialize: (store) => ({
    traceId: store.traceId,
    tenantId: store.tenantId,
    userRef: store.userRef,
  }),
  deserialize: (carrier) => ({
    traceId: carrier.traceId,
    tenantId: carrier.tenantId,
    userRef: carrier.userRef,
  }),
})
```

Baggage propagation is tuned independently — namespace a key or drop a field:

```ts
export default defineConfig({
  baggage: {
    tenantId: 'acme.tenant', // namespaced baggage key
    userRef: false,          // never put the principal on a baggage header
  },
})
```

Source: `docs/customization.mdx` (Level 4), `packages/core/src/define_config.ts`.

### Pattern 3 — configure a bare worker without the provider

A process that never boots the AdonisJS application has no provider, so the
singleton keeps defaults. Call `Context.configure()` once at process start.
It reads **only** the cross-boundary keys (`carrier`, `serialize`,
`deserialize`, `baggage`, `enrichers`) — passing `traceHeader`/`traceId`/
`initialize` has no effect there.

```ts
// worker.ts
import { Context } from '@adonis-agora/context'
import contextConfig from '#config/context' // reuse the app's own config

Context.configure(contextConfig)
```

Source: `docs/customization.mdx` (Level 3 — Configuring the singleton without the provider).

### Pattern 4 — swap the accessor consumer libraries read

Consumer libs never import this package; they read a structural accessor from
a `globalThis` slot published at import time. Overwrite the slot to change what
they see (e.g. hydrate the full user). Do it early, e.g. in a provider `boot()`.

```ts
import { CONTEXT_ACCESSOR, type ContextAccessor, Context } from '@adonis-agora/context'

const hydrating: ContextAccessor = {
  traceId: () => Context.traceId(),
  tenantId: () => Context.tenantId(),
  userRef: () => Context.userRef(),
  get: ((key?: string) => {
    const store = Context.get()
    return key === undefined ? store : store?.[key as keyof typeof store]
  }) as ContextAccessor['get'],
}
;(globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] = hydrating
```

Two sibling slots complete the set — `CONTEXT_SET` merges a patch into an
already-active store, `CONTEXT_SCOPE` establishes a whole store around a
callback (the primitive durable reads):

```ts
import { contextWriter, contextScope } from '@adonis-agora/context'

contextWriter.set({ userRef: { type: 'user', id: 42 }, tenantId: 'acme' }) // no-op w/o context
const result = contextScope(snapshot, () => doTheWork()) // runs INSIDE the snapshot's store
```

Source: `docs/customization.mdx` (Level 5 + writing context from sibling libraries),
`packages/core/src/accessor.ts`, `packages/core/src/writer.ts`.

## Common mistakes

### CRITICAL — Implementing only the no-argument form of a custom accessor's `get()`

Wrong:

```ts
const accessor: ContextAccessor = {
  traceId: () => Context.traceId(),
  tenantId: () => Context.tenantId(),
  userRef: () => Context.userRef(),
  get: () => Context.get(), // no-arg only
}
;(globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] = accessor
```

Correct:

```ts
get: ((key?: string) => {
  const store = Context.get()
  return key === undefined ? store : store?.[key as keyof typeof store]
}) as ContextAccessor['get']
```

Mechanism: consumers are split across both forms — some read the whole store,
authz reads single fields via `get('globalRoles')`. A no-arg-only accessor
passes every compile-time structural check, but keyed calls silently return
the **whole store** where a field was expected; nothing throws, yet every
consumer reading a field gets garbage (the documented incident: authz resolved
`[]` for every role check, so permissions failed closed). Source:
`docs/customization.mdx` ("`get` is overloaded" warn callout).

### CRITICAL — Swapping the accessor through the IoC container

Wrong:

```ts
// compiles, runs… and changes nothing
await app.container.swap(CONTEXT_ACCESSOR, () => myAccessor)
```

Correct:

```ts
;(globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] = myAccessor
```

Mechanism: `CONTEXT_ACCESSOR` is a `Symbol.for` globalThis slot, not a
container binding — the provider binds nothing (it only pushes config onto the
singleton during `boot()`), so container swaps are no-ops. Consumers read the
slot structurally at call time. Source: `docs/customization.mdx`
("globalThis slot, not an IoC binding" callout), `packages/core/src/accessor.ts`.

### HIGH — Assuming `Context.configure()` merges with previous config

Wrong:

```ts
Context.configure({ carrier: ['traceId', 'tenantId', 'userRef'] })
// later, "just adding" enrichers — silently drops nothing? No: replaces everything.
Context.configure({ enrichers: [(s) => { s.region = 'eu' }] })
// serialize now uses DEFAULTS again; locale no longer travels.
```

Correct:

```ts
Context.configure({
  carrier: ['traceId', 'tenantId', 'userRef'],
  enrichers: [(s) => { s.region = 'eu' }],
})
// In multi-app/test harnesses, between configs:
Context.resetConfig()
```

Mechanism: the cross-boundary config is process-global (module-level singleton,
outside the IoC container so workers/hooks can reach it) and each `configure`
call REPLACES it wholesale by design — guaranteeing you can never pair one
app's `serialize` with another's `deserialize`. A second differing call emits a
`console.warn`. Source: `docs/customization.mdx`
("The carrier config is process-global" callout), `packages/core/src/context.ts`
(`Context.configure`).

### MEDIUM — Reading request headers off an enricher's `req` without narrowing

Wrong:

```ts
enrichers: [
  (store, req) => ({ region: req.request.header('x-region') }),
  // TS18046: 'req' is of type 'unknown'
]
```

Correct:

```ts
enrichers: [
  (store, req) => {
    const ctx = req as HttpContext | undefined
    return ctx?.request.header('x-region')
      ? { region: (req as HttpContext).request.header('x-region')! }
      : undefined
  },
]
```

Mechanism: enrichers run on both sides of the HTTP boundary — the middleware
passes `HttpContext` while `Context.runEnrichers(req)` passes whatever the
caller forwards (often nothing) — so the parameter is typed `unknown` on
purpose. Narrow with `HttpContext | undefined` so worker-side calls simply skip
header lookups. Source: `docs/customization.mdx`
("The second argument is unknown" section).

### HIGH — Expecting augmenting a field to populate it (or make it travel)

Wrong:

```ts
declare module '@adonis-agora/context' {
  interface ContextStore {
    locale?: string
  }
}
// …and then expecting Context.get()?.locale to be set, or to survive the queue.
```

Correct:

```ts
// Populate it (Level 2) and opt it into the carrier (Level 4):
export default defineConfig({
  initialize: (ctx) => ({ locale: ctx.request.header('accept-language') }),
  carrier: ['traceId', 'tenantId', 'userRef', 'locale'],
})
```

Mechanism: module augmentation is a compile-time contract only — it tells
TypeScript the field exists, populates nothing, and adds nothing to the wire;
the default carrier stays `traceId` + `tenantId` + `userRef`. Source:
`docs/the-store.mdx` (module-augmentation warn callout),
`docs/customization.mdx` (Levels 1–4).

See also: context-cross-process/SKILL.md — how the carrier/baggage config is
consumed at boundaries; context-basics/SKILL.md — declaring custom fields via
module augmentation and the testing helpers that reset global state.
