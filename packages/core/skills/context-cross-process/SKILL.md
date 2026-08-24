---
name: context-cross-process
description: >-
  Carry @adonis-agora/context across process boundaries where AsyncLocalStorage
  dies: Context.serialize() / Context.deserialize(carrier, fn) with the
  ContextCarrier snapshot ({ traceId, tenantId?, userRef? }), the two-line
  @adonisjs/queue pattern (__ctx payload field on dispatch, deserialize in the
  job handler), ace-command Context.run, Context.bind() for setTimeout /
  EventEmitter blind spots, W3C baggage via toBaggage / fromBaggage plus the
  encodeBaggage / decodeBaggage / encodeUserRef / decodeUserRef codecs, the
  traceparent helpers extractTraceparent / parseTraceparent / toTraceparent,
  and automatic propagation through @adonis-agora/durable ctx.call. Use for
  "queue worker loses the current user/tenant", "pass context to a background
  job", "propagate traceId across services", or "baggage header".
metadata:
  type: core
  library: "@adonis-agora/context"
  library_version: "0.6.0"
  framework: adonisjs
license: MIT
sources:
  - 'DavideCarvalho/adonis-context:docs/cross-process.mdx'
  - 'DavideCarvalho/adonis-context:docs/customization.mdx'
  - 'DavideCarvalho/adonis-context:packages/core/src/context.ts'
  - 'DavideCarvalho/adonis-context:packages/core/src/baggage.ts'
  - 'DavideCarvalho/adonis-context:packages/core/src/traceparent.ts'
---

# @adonis-agora/context — cross-process propagation

`AsyncLocalStorage` propagates a store along the async execution tree **within
one process** only. Push a job onto a Redis-backed queue, dispatch a remote
durable task, or spawn a sub-process, and the store is gone — the worker starts
with an empty context. The fix is an explicit serializable snapshot:
`Context.serialize()` on one side, `Context.deserialize(carrier, fn)` on the
other.

## Setup

The whole integration across a raw queue is two lines:

```ts
// app/services/invoice_service.ts — dispatch side (inside an HTTP request)
import queue from '@adonisjs/queue/services/main'
import { Context } from '@adonis-agora/context'

export default class InvoiceService {
  async requestInvoice(payload: { invoiceId: number; email: string }) {
    await queue.dispatch('send-invoice', {
      ...payload,
      __ctx: Context.serialize(), // snapshot who / which tenant / which trace
    })
  }
}
```

```ts
// app/jobs/send_invoice_job.ts — consume side (fresh process, no context yet)
import { Context, type ContextCarrier } from '@adonis-agora/context'

export default class SendInvoiceJob {
  async handle(payload: { invoiceId: number; email: string } & { __ctx?: ContextCarrier }) {
    return Context.deserialize(payload.__ctx, () => this.send(payload))
  }

  private async send(payload: { invoiceId: number; email: string }) {
    // Inside here: Context.userRef() is the principal who enqueued the job,
    // Context.tenantId() their tenant, Context.traceId() the originating request.
  }
}
```

`__ctx` is a convention, not an API — any key works as long as both sides
agree. A job arriving without a carrier still works (`deserialize(undefined, fn)`
just runs `fn` with no active store).

## Core patterns

### Pattern 1 — ace commands get a context with `Context.run`

A cron-triggered command has no HTTP request. Wrap the body in `Context.run`
(you own a clean callback boundary), so everything it does — including jobs it
dispatches — carries a trace id.

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

Source: `docs/cross-process.mdx` (ace commands).

### Pattern 2 — W3C baggage for baggage-aware peers

Instead of (or alongside) the bespoke carrier, the context can ride a real W3C
`baggage` header that OpenTelemetry SDKs and gateways understand.

```ts
import { Context } from '@adonis-agora/context'

// Build a baggage header from the active context ('tenantId=t1,userRef=user%3A42').
const header = Context.toBaggage()

// Re-hydrate inside an inbound baggage header. Baggage has no trace id, so it
// is seeded from `traceparent` when supplied, else a fresh random id.
Context.fromBaggage(req.headers.baggage, () => doTheWork(), {
  traceparent: req.headers.traceparent,
})
```

Four pure codecs power these and are exported too:

```ts
import { encodeBaggage, decodeBaggage, encodeUserRef, decodeUserRef } from '@adonis-agora/context'

const header = encodeBaggage({ tenantId: 't1', userRef: encodeUserRef({ type: 'user', id: 42 }) })
const map = decodeBaggage(header)      // { tenantId: 't1', userRef: 'user:42' }
const ref = decodeUserRef(map.userRef) // { type: 'user', id: '42' }
```

Source: `docs/cross-process.mdx` (W3C baggage), `packages/core/src/baggage.ts`.

### Pattern 3 — `bind()` for ALS's blind spots

Callbacks registered now but invoked later outside the originating async tree —
`setTimeout`, `setInterval`, `EventEmitter` listeners — lose the ambient store.
`Context.bind(fn)` snapshots whatever is active at bind time and re-enters it
on each invocation; arguments, `this` and the return value pass through.

```ts
import { Context } from '@adonis-agora/context'

emitter.on('done', Context.bind(() => log(Context.traceId())))
setTimeout(Context.bind(handler), 1000)
```

Source: `docs/cross-process.mdx` (bind()), `packages/core/src/context.ts` (`Context.bind`).

### Pattern 4 — faithful downstream `traceparent` re-emission

`toTraceparent(traceId, upstream?)` builds a `00-<traceId>-<spanId>-<flags>`
header. Passing the upstream parse captured at request start
(`store.traceparent`) continues the incoming trace — same parent span-id and
sampling flags — instead of minting a fresh span marked sampled.

```ts
import { Context, toTraceparent } from '@adonis-agora/context'

toTraceparent(Context.traceId()!)                    // new span-id, flags 01 (sampled)
toTraceparent(Context.traceId()!, Context.get()?.traceparent) // continues upstream trace
```

This hook is exactly how `@adonis-agora/durable` ships the trace id across its
transport:

```ts
const engine = new WorkflowEngine({
  store,
  traceparent: () => {
    const traceId = Context.traceId()
    if (!traceId) return undefined
    return toTraceparent(traceId, Context.get()?.traceparent)
  },
})
```

Source: `docs/the-store.mdx` (traceId invariant section),
`packages/core/src/traceparent.ts`.

### Pattern 5 — durable needs zero lines

Across `@adonis-agora/durable` you write no serialize/deserialize calls:
`ctx.call(remoteStep, input)` snapshots the active context onto the
`RemoteTask`, ships it, and restores it via the scoped
`Symbol.for('@agora/context:scope')` slot before invoking your handler — even
when that handler runs in another process or language.

```ts
// Worker-side handler — NO deserialize here; durable already restored the context.
transport.handle('payments.charge-card', async (input) => {
  Context.userRef()  // the user who started the workflow
  Context.tenantId() // their tenant
  Context.traceId()  // the originating request's trace id
  return { chargeId: await charge(input) }
})
```

Raw queue: two lines you write. Durable: zero lines. Same snapshot semantics
either way. Source: `docs/cross-process.mdx` (durable sections).

## Common mistakes

### CRITICAL — Treating the carrier as a live view of the user

Wrong:

```ts
// Job enqueued Monday; user deactivated Tuesday. Handler trusts the carrier:
await Context.deserialize(payload.__ctx, async () => {
  const user = await User.findOrFail(Context.userRef()!.id) // may now be inactive
  await actAs(user) // acts with authority that no longer exists
})
```

Correct:

```ts
await Context.deserialize(payload.__ctx, async () => {
  // Re-resolve authority from the stable ref if the CURRENT state matters;
  // the snapshot is deliberately the history of the dispatch moment.
  const ref = Context.userRef()
  const current = await User.findOrFail(ref!.id)
  if (!current.isActive) throw new Error('principal deactivated since dispatch')
  await actAs(current)
})
```

Mechanism: `serialize()` captures user/tenant at call time (dispatch time); a
long-running workflow re-hydrates that snapshot by design — steps should act
with dispatched authority unless they explicitly re-resolve. Source:
`docs/cross-process.mdx` (The snapshot caveat callout).

### HIGH — Re-hydrating with `enterWith` in a queue worker

Wrong:

```ts
// worker.ts — enterWith pollutes every subsequent job this process handles
app.jobs.on('received', (job) => Context.enterWith(job.__ctx as ContextStore))
```

Correct:

```ts
// Scope the restored store to exactly one job's callback:
job.handle = (payload: JobPayload & { __ctx?: ContextCarrier }) =>
  Context.deserialize(payload.__ctx, () => realHandle(payload))
```

Mechanism: `deserialize(carrier, fn)` runs `fn` inside the rebuilt store and
tears it down when the callback returns, so concurrent jobs in one process stay
isolated; `enterWith` swaps the process-wide active execution with no cleanup.
It also tolerates a nullish carrier instead of throwing. Source:
`packages/core/src/context.ts` (`deserialize`),
`docs/getting-started.mdx` (Why enterWith, not run).

### MEDIUM — Assuming a missing carrier or trace id breaks the worker

Wrong:

```ts
const carrier = job.payload.__ctx ?? { traceId: undefined as never }
if (!carrier.traceId) throw new Error('no trace id on carrier') // unnecessary crash
return Context.deserialize(carrier, () => work())
```

Correct:

```ts
// Pass it straight through: no carrier → runs with no store; carrier without a
// traceId → a fresh randomTraceId() is synthesized (with a one-time warn).
return Context.deserialize(job.payload.__ctx, () => work())
```

Mechanism: `deserialize` protects the `ContextStore.traceId: string` invariant —
a carrier arriving without a trace id gets `randomTraceId()` (one-shot
`console.warn`) rather than propagating `undefined`, and a nullish carrier runs
the callback without throwing. Source: `packages/core/src/context.ts`
(`ensureTraceId`, `deserialize`), `docs/cross-process.mdx` (trace-id safety net).

### HIGH — Expecting custom fields to ride the default carrier

Wrong:

```ts
// types/context.ts augmented `locale?: string`; config never opted it in.
queue.dispatch('greet', { __ctx: Context.serialize() })
// worker: Context.get()?.locale → undefined even though it was set before dispatch
```

Correct:

```ts
// config/context.ts — list the field explicitly (or override serialize entirely):
export default defineConfig({
  carrier: ['traceId', 'tenantId', 'userRef', 'locale'],
})
```

Mechanism: the default carrier includes only `traceId` + `tenantId` +
`userRef`; module augmentation declares a field but nothing puts it on the wire
until it joins the `carrier` list or a full `serialize` override. Source:
`docs/customization.mdx` (Level 4), `packages/core/src/context.ts`
(`defaultSerialize`). Config details: see the `context-customization` skill.

### MEDIUM — Hand-rolling baggage encoding instead of using the exported codecs

Wrong:

```ts
const header = `tenantId=${tenantId},userRef=${type}:${id}` // breaks on special chars
```

Correct:

```ts
import { encodeBaggage, encodeUserRef } from '@adonis-agora/context'
const header = encodeBaggage({
  tenantId,
  userRef: encodeUserRef({ type, id }), // percent-encoded per W3C rules
})
```

Mechanism: baggage values must be percent-encoded; raw concatenation produces
invalid headers for values containing `,` `=` `%`. The exported codecs are the
exact primitives `toBaggage` uses internally, and `decodeBaggage` tolerates
malformed members rather than throwing. Source: `docs/cross-process.mdx`
(low-level codecs table), `packages/core/src/baggage.ts`.

See also: context-basics/SKILL.md — establishing and reading the store;
context-customization/SKILL.md — tuning what travels (`carrier`, `baggage`,
`serialize`/`deserialize` overrides) and the globalThis slots durable reads.
