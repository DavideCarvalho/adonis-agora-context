---
name: context-basics
description: >-
  Set up @adonis-agora/context in an AdonisJS 7 app and read the ambient
  AsyncLocalStorage store anywhere: node ace configure codemod, the
  server-stack context_middleware, defineConfig in config/context.ts,
  Context.traceId() / tenantId() / userRef() / get(), Context.set('userRef',
  { type, id }) after auth, ContextStore/UserRef shape, module augmentation of
  interface ContextStore, Context.run vs Context.enterWith, testing helpers
  runWithContext / enterContext from @adonis-agora/context/testing, and the
  defineTenantConnections helper from @adonis-agora/context/lucid. Use for
  "install/configure the context package", "get current user/tenant/traceId in
  a service or Lucid hook", "Context.set does nothing / warns", or "add custom
  fields to ContextStore".
metadata:
  type: core
  library: "@adonis-agora/context"
  library_version: "0.6.0"
  framework: adonisjs
license: MIT
sources:
  - 'DavideCarvalho/adonis-context:docs/getting-started.mdx'
  - 'DavideCarvalho/adonis-context:docs/the-store.mdx'
  - 'DavideCarvalho/adonis-context:docs/database-per-tenant.mdx'
  - 'DavideCarvalho/adonis-context:docs/testing.mdx'
  - 'DavideCarvalho/adonis-context:packages/core/src/context.ts'
  - 'DavideCarvalho/adonis-context:packages/core/src/context_middleware.ts'
---

# @adonis-agora/context — setup and reading the store

`@adonis-agora/context` is a module-level `AsyncLocalStorage` singleton that
carries `userRef` / `tenantId` / `traceId` through every layer of an AdonisJS
app — controllers, services, Lucid hooks, queue workers, ace commands — without
prop-drilling and without `HttpContext.getOrFail()` (which throws outside HTTP).
You wire it once with the configure codemod; your auth layer stamps the
principal afterwards; everything downstream reads accessors.

## Setup

```sh
node ace add @adonis-agora/context
```

`add` installs the package and runs `node ace configure`, which runs three
codemods with zero manual wiring:

1. registers the provider (`@adonis-agora/context/context_provider`) in `adonisrc.ts`;
2. registers the context middleware (`@adonis-agora/context/context_middleware`)
   on the **server** middleware stack;
3. publishes `config/context.ts` from a stub.

The published config is all-optional — defaults work out of the box:

```ts
// config/context.ts
import { defineConfig } from '@adonis-agora/context'

export default defineConfig({
  // traceHeader: 'traceparent',
  // initialize: (ctx) => ({ tenantId: ctx.request.header('x-tenant-id') }),
})
```

Read the context anywhere by importing the singleton — no injection, no
`app.container.make`:

```ts
import { Context } from '@adonis-agora/context'

Context.traceId()  // string | undefined — request correlation id (always set inside a request)
Context.tenantId() // string | undefined — active tenant
Context.userRef()  // { type, id } | undefined — acting principal
Context.get()      // full ContextStore | undefined
```

After auth, stamp the principal onto the store the middleware entered:

```ts
// app/middleware/stamp_context_middleware.ts
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { Context } from '@adonis-agora/context'

export default class StampContextMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.auth.user
    if (user) {
      Context.set('userRef', { type: 'user', id: user.id })
      Context.set('tenantId', user.tenantId)
    }
    return next()
  }
}
```

## Core patterns

### Pattern 1 — add typed custom fields via module augmentation

The `ContextStore` is open for extension; declare extra fields once anywhere
your build includes. Augmentation only declares — populate via `initialize`,
an enricher, or `Context.set()`.

```ts
// types/context.ts
import '@adonis-agora/context'

declare module '@adonis-agora/context' {
  interface ContextStore {
    locale?: string
    impersonatorId?: string
  }
}
```

```ts
Context.set('locale', 'pt-BR')        // ✓ typed
Context.set('locale', 42)             // ✗ type error
```

Keep augmented fields serializable if they should ever cross a process boundary.

Source: `docs/the-store.mdx` (Adding your own typed fields).

### Pattern 2 — unit-test code that reads the context

The `@adonis-agora/context/testing` subpath builds a real ALS store (no mock)
from a partial; `traceId` is auto-filled when omitted. `runWithContext`
scopes to a callback; `enterContext` persists past the call for code that reads
the context across an `await`.

```ts
import { runWithContext } from '@adonis-agora/context/testing'
import { Context } from '@adonis-agora/context'
import { test } from '@japa/runner'

test('reads the tenant from context', () => {
  runWithContext({ tenantId: 't1', userRef: { type: 'user', id: 7 } }, () => {
    assert.equal(Context.tenantId(), 't1')
    assert.isDefined(Context.traceId()) // auto-filled
  })
})

test('keeps the context across an await', async () => {
  const { enterContext } = await import('@adonis-agora/context/testing')
  enterContext({ tenantId: 't1' })
  await service.doSomethingAsync()
  assert.equal(Context.tenantId(), 't1')
})
```

Source: `docs/testing.mdx`, `packages/core/src/testing/index.ts`.

### Pattern 3 — database per tenant, fail-closed

The `@adonis-agora/context/lucid` subpath turns the ambient `tenantId` into the
right Lucid connection. With **no tenant in context** it throws
`NoTenantInContextError` instead of falling back to the default connection —
a silent default-DB read is a cross-tenant leak. Declare `sharedConnection`
only for legitimately tenant-less paths.

```ts
import { defineTenantConnections } from '@adonis-agora/context/lucid'

export const tenancy = defineTenantConnections({
  resolve: (tenantId) => `tenant_${tenantId}`,
  // sharedConnection: 'public', // opt-in for global jobs/shared tables
})

await Invoice.query({ connection: tenancy.connectionName() })
await tenancy.client(db).from('invoices').select('*')

// Resolve for another tenant than the ambient one (fan-out jobs):
tenancy.connectionName({ tenantId: 'globex' })
```

Source: `docs/database-per-tenant.mdx`, `packages/core/src/lucid/tenant_connection.ts`.

### Pattern 4 — establish a context outside HTTP

For an ace command or scheduled task there is no request, so no store exists
until you create one. Use `Context.run` (you own a clean callback boundary),
not `enterWith`.

```ts
import { BaseCommand } from '@adonisjs/core/ace'
import { Context, randomTraceId } from '@adonis-agora/context'

export default class Reconcile extends BaseCommand {
  static commandName = 'reconcile'

  async run() {
    await Context.run(
      { traceId: randomTraceId(), userRef: { type: 'system', id: 'cron' } },
      () => this.reconcileAll(),
    )
  }
}
```

Source: `docs/cross-process.mdx` (ace commands), `docs/getting-started.mdx` (Why enterWith, not run).

## Common mistakes

### CRITICAL — Stamping `Context.set()` where no context is active

Wrong:

```ts
// app/middleware/before_server_stack.ts — runs BEFORE the context middleware
export default class EarlyAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (ctx.auth.user) {
      // silently dropped: the server-stack context middleware hasn't run yet
      Context.set('userRef', { type: 'user', id: ctx.auth.user.id })
    }
    return next()
  }
}
```

Correct:

```ts
// Runs AFTER auth on the router stack — the store already exists.
export default class StampContextMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const user = ctx.auth.user
    if (user) {
      Context.set('userRef', { type: 'user', id: user.id })
      Context.set('tenantId', user.tenantId)
    }
    return next()
  }
}
```

Mechanism: out-of-context `set()` never throws (backward compatibility), but the
value is silently dropped and a one-shot `console.warn` fires once per process;
`Context.resetSetWarning()` re-arms it. Source:
`packages/core/src/context.ts` (`Context.set`),
`docs/getting-started.mdx` (set() outside a context is a no-op callout).

### HIGH — Moving the middleware off the server stack or wrapping `next()` in `Context.run`

Wrong:

```ts
// router stack only: routes without explicit registration get NO context
router.use([() => import('@adonis-agora/context/context_middleware')])

// or "safer" scoping around next():
async handle(ctx: HttpContext, next: NextFn) {
  return Context.run({ traceId: randomTraceId() }, () => next())
}
```

Correct:

```ts
// server stack (what `node ace configure` wires): every request gets a store,
// established with enterWith so it survives this middleware returning.
async handle(ctx: HttpContext, next: NextFn) {
  Context.enterWith({ traceId, requestId })
  return next()
}
```

Mechanism: `Context.run` tears the store down the moment its callback returns —
before your async controller method executes; the named/router stack skips
requests that never hit those routes. The built-in middleware uses `enterWith`
on the server stack precisely so the whole downstream pipeline sees the store.
Source: `docs/getting-started.mdx` (Why `enterWith`, not `run` + server-stack
callout), `packages/core/src/context_middleware.ts`.

### HIGH — Expecting `initialize()` to control the trace id

Wrong:

```ts
export default defineConfig({
  initialize: (ctx) => ({
    traceId: ctx.request.header('x-request-id') ?? '', // overwritten
    tenantId: ctx.subdomains?.tenant,
  }),
})
```

Correct:

```ts
export default defineConfig({
  traceId: (ctx) => ctx.request.header('x-correlation-id') ?? randomTraceId(),
  initialize: (ctx) => ({ tenantId: ctx.subdomains?.tenant }),
})
```

Mechanism: the middleware merges the `initialize(ctx)` bag into the store
FIRST and writes the resolved `traceId`/`requestId` LAST, so the dedicated path
always wins over anything `initialize()` returns. Source:
`docs/customization.mdx` (Precedence section), `packages/core/src/context_middleware.ts`.

### MEDIUM — Treating accessor `undefined` as an error to defend against

Wrong:

```ts
const traceId = Context.traceId()
if (!traceId) throw new Error('context missing') // boot-time code now crashes
logger.info({ traceId }, 'boot')
```

Correct:

```ts
// Accessors never throw; undefined simply means "outside any context" (e.g. app boot).
logger.info({ traceId: Context.traceId(), context: VERSION }, 'boot')
```

Mechanism: every accessor returns `undefined` outside an active store by design
— during boot, in un-wrapped workers, everywhere. Only `traceId` is
non-optional *inside* a store; nothing guarantees a store exists at all.
Source: `docs/getting-started.mdx` Step 2, `packages/core/src/context.ts`.

### HIGH — Putting the full user model into the store

Wrong:

```ts
// drags relations + a live DB connection onto the store; cannot cross boundaries
Context.set('userRef', user as never)
```

Correct:

```ts
Context.set('userRef', { type: 'user', id: user.id })   // stable, serializable ref
const freshUser = await User.find(Context.userRef()!.id) // resolve when needed
```

Mechanism: the store carries a `{ type, id }` reference — not the hydrated
Lucid model — because it must survive `serialize()` across queue/process
boundaries and stay decoupled from your models. Source:
`docs/the-store.mdx` (Why a UserRef, not the full user).

See also: context-cross-process/SKILL.md — carrying these values across queue
and durable boundaries; context-customization/SKILL.md — populating custom
fields and swapping the accessor consumer libraries read.
