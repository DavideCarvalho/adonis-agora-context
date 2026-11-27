---
name: context-cross-process
description: >-
  Carry @adonis-agora/context across process boundaries where AsyncLocalStorage
  dies: Context.serialize() / Context.deserialize(carrier, fn) with the
  ContextCarrier snapshot ({ traceId, tenantId?, userRef?, tenant?,
  tenantFamilies? — the last two ride whenever tenancy is enabled }), the two-line
  @adonisjs/queue pattern (__ctx payload field on dispatch, deserialize in the
  job handler), ace-command Context.run, Context.bind() for setTimeout /
  EventEmitter blind spots, W3C baggage via toBaggage / fromBaggage plus the
  encodeBaggage / decodeBaggage / encodeUserRef / decodeUserRef codecs, the
  traceparent helpers extractTraceparent / parseTraceparent / toTraceparent,
  and automatic propagation through @adonis-agora/durable ctx.step. Use for
  "queue worker loses the current user/tenant", "pass context to a background
  job", "propagate traceId across services", or "baggage header".
metadata:
  type: core
  library: "@adonis-agora/context"
  library_version: "1.0.0"
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
import SendInvoiceJob from '#jobs/send_invoice_job'
import { Context } from '@adonis-agora/context'

export default class InvoiceService {
  async requestInvoice(payload: { invoiceId: number; email: string }) {
    await SendInvoiceJob.dispatch({
      ...payload,
      __ctx: Context.serialize(), // snapshot who / which tenant / which trace
    })
  }
}
```

```ts
// app/jobs/send_invoice_job.ts — consume side (fresh process, no context yet)
import { Job } from '@adonisjs/queue'
import { Context, type ContextCarrier } from '@adonis-agora/context'

interface SendInvoicePayload {
  invoiceId: number
  email: string
  __ctx?: ContextCarrier
}

export default class SendInvoiceJob extends Job<SendInvoicePayload> {
  async execute() {
    return Context.deserialize(this.payload.__ctx, () => this.send(this.payload))
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

  private async reconcileAll() {
    // … the command's work: queries, dispatched jobs, logs
  }
}
```

Source: `docs/cross-process.mdx` (ace commands).

### Pattern 2 — W3C baggage for baggage-aware peers

Instead of (or alongside) the bespoke carrier, the context can ride a real W3C
`baggage` header that OpenTelemetry SDKs and gateways understand.

```ts
import type { HttpContext } from '@adonisjs/core/http'
import { Context } from '@adonis-agora/context'
import { serviceTokens, verifyServiceToken } from '#services/service_tokens'
import { doTheWork, handle, type Message } from '#services/work'

export async function inbound({ request }: HttpContext) {
  // Build a baggage header from the active context ('tenantId=t1,userRef=user%3A42',
  // plus 'tenantKind=<kind>' when tenancy is enabled and the kind is known).
  const header = Context.toBaggage()

  // Re-hydrate inside an inbound baggage header. Baggage has no trace id, so it
  // is seeded from `traceparent` when supplied, else a fresh random id.
  // Identity (tenantId, tenantKind, userRef) in incoming baggage is DROPPED unless
  // the call opts in: baggage is unauthenticated, any client can forge it.
  Context.fromBaggage(request.header('baggage'), () => doTheWork(), {
    traceparent: request.header('traceparent'),
    // Verify: return true, false, or your own verified { tenantId, userRef }.
    trust: () => verifyServiceToken(request.header('authorization')) !== undefined,
  })

  // Async verifier (fetch a key, look up a token)? Use fromBaggageVerified, which
  // returns a Promise. An async `trust` on the sync fromBaggage is a type error and
  // throws at runtime. A verifier that throws/rejects fails closed on both paths:
  // identity dropped, fn still runs, error console.warn'ed. Return false to reject.
  await Context.fromBaggageVerified(request.header('baggage'), () => doTheWork(), {
    trust: async () => (await serviceTokens.verify(request.header('authorization'))) !== undefined,
  })
}

// Or, only on a hop you control end to end:
export function onMessage(message: Message) {
  Context.fromBaggage(message.headers.baggage, () => handle(message), { trustIdentity: true })
}
// `tenancy.trustBaggage: true` accepts the tenant (never the user) app-wide, for
// apps behind a gateway that strips client baggage.
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
import { EventEmitter } from 'node:events'
import logger from '@adonisjs/core/services/logger'
import { Context } from '@adonis-agora/context'

const emitter = new EventEmitter()
emitter.on('done', Context.bind(() => logger.info({ traceId: Context.traceId() }, 'done')))
setTimeout(Context.bind(() => logger.info({ traceId: Context.traceId() }, 'tick')), 1000)
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
// config/durable.ts
import { defineConfig } from '@adonis-agora/durable'
import { Context, toTraceparent } from '@adonis-agora/context'

export default defineConfig({
  // ...store, transport
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
`ctx.step(step, input)` snapshots the active context onto the
`RemoteTask`, ships it, and restores it via the scoped
`Symbol.for('@agora/context:scope')` slot before invoking your step handler —
even when that handler runs in another process or language.

```ts
// app/steps/charge_card.ts — NO deserialize here; durable already restored the context.
import { defineStep } from '@adonis-agora/durable'
import { Context } from '@adonis-agora/context'
import { charge } from '#services/billing'

export const chargeCard = defineStep('payments:charge-card', async (input: { amountCents: number }) => {
  Context.userRef()  // the user who started the workflow
  Context.tenantId() // their tenant
  Context.traceId()  // the originating request's trace id
  return { chargeId: await charge(input) }
})

// in the workflow: await ctx.step(chargeCard, input)
```

Raw queue: two lines you write. Durable: zero lines. Same snapshot semantics
either way. Source: `docs/cross-process.mdx` (durable sections).

## Common mistakes

### CRITICAL — Treating the carrier as a live view of the user

Wrong:

```ts
// Job enqueued Monday; user deactivated Tuesday. Handler trusts the carrier:
import { Job } from '@adonisjs/queue'
import { Context, type ContextCarrier } from '@adonis-agora/context'
import User from '#models/user'
import { actAs } from '#services/impersonation'

export default class ExportJob extends Job<{ __ctx?: ContextCarrier }> {
  async execute() {
    await Context.deserialize(this.payload.__ctx, async () => {
      const user = await User.findOrFail(Context.userRef()!.id) // may now be inactive
      await actAs(user) // acts with authority that no longer exists
    })
  }
}
```

Correct:

```ts
import { Job } from '@adonisjs/queue'
import { Context, type ContextCarrier } from '@adonis-agora/context'
import User from '#models/user'
import { actAs } from '#services/impersonation'

export default class ExportJob extends Job<{ __ctx?: ContextCarrier }> {
  async execute() {
    await Context.deserialize(this.payload.__ctx, async () => {
      // Re-resolve authority from the stable ref if the CURRENT state matters;
      // the snapshot is deliberately the history of the dispatch moment.
      const ref = Context.userRef()
      const current = await User.findOrFail(ref!.id)
      if (!current.isActive) throw new Error('principal deactivated since dispatch')
      await actAs(current)
    })
  }
}
```

Mechanism: `serialize()` captures user/tenant at call time (dispatch time); a
long-running workflow re-hydrates that snapshot by design — steps should act
with dispatched authority unless they explicitly re-resolve. Source:
`docs/cross-process.mdx` (The snapshot caveat callout).

### HIGH — Re-hydrating with `enterWith` in a queue worker

Wrong:

```ts
// app/jobs/send_invoice_job.ts — enterWith pollutes every subsequent job this worker runs
import { Job } from '@adonisjs/queue'
import { Context, type ContextCarrier, type ContextStore } from '@adonis-agora/context'

export default class SendInvoiceJob extends Job<{ invoiceId: number; __ctx?: ContextCarrier }> {
  async execute() {
    Context.enterWith(this.payload.__ctx as ContextStore)
    await this.send()
  }

  private async send() {}
}
```

Correct:

```ts
// Scope the restored store to exactly one job's callback:
import { Job } from '@adonisjs/queue'
import { Context, type ContextCarrier } from '@adonis-agora/context'

export default class SendInvoiceJob extends Job<{ invoiceId: number; __ctx?: ContextCarrier }> {
  async execute() {
    await Context.deserialize(this.payload.__ctx, () => this.send())
  }

  private async send() {}
}
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
import { Job } from '@adonisjs/queue'
import { Context, type ContextCarrier } from '@adonis-agora/context'

export default class SendInvoiceJob extends Job<{ invoiceId: number; __ctx?: ContextCarrier }> {
  async execute() {
    const carrier = this.payload.__ctx ?? { traceId: undefined as never }
    if (!carrier.traceId) throw new Error('no trace id on carrier') // unnecessary crash
    await Context.deserialize(carrier, () => this.send())
  }

  private async send() {}
}
```

Correct:

```ts
import { Job } from '@adonisjs/queue'
import { Context, type ContextCarrier } from '@adonis-agora/context'

export default class SendInvoiceJob extends Job<{ invoiceId: number; __ctx?: ContextCarrier }> {
  async execute() {
    // Pass it straight through: no carrier → runs with no store; carrier without a
    // traceId → a fresh randomTraceId() is synthesized (with a one-time warn).
    await Context.deserialize(this.payload.__ctx, () => this.send())
  }

  private async send() {}
}
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
import GreetJob from '#jobs/greet_job'
import { Context } from '@adonis-agora/context'

await GreetJob.dispatch({ __ctx: Context.serialize() })
// worker: Context.get()?.locale → undefined even though it was set before dispatch
```

Correct:

```ts
// config/context.ts — list the field explicitly (or override serialize entirely):
import { defineConfig } from '@adonis-agora/context'

export default defineConfig({
  carrier: ['traceId', 'tenantId', 'userRef', 'locale'],
})
```

Mechanism: the default carrier includes only `traceId` + `tenantId` +
`userRef` — plus `tenant`/`tenantFamilies` whenever `tenancy.enabled` is true
(the tenant rides every carrier then, even a `carrier` list or custom
`serialize` that omits it); module augmentation declares a field but nothing puts it on the wire
until it joins the `carrier` list or a full `serialize` override. Source:
`docs/customization.mdx` (Level 4), `packages/core/src/context.ts`
(`defaultSerialize`). Config details: see the `context-customization` skill.

### MEDIUM — Hand-rolling baggage encoding instead of using the exported codecs

Wrong:

```ts
import type { UserRef } from '@adonis-agora/context'

function baggageFor(tenantId: string, { type, id }: UserRef) {
  return `tenantId=${tenantId},userRef=${type}:${id}` // breaks on special chars
}
```

Correct:

```ts
import { encodeBaggage, encodeUserRef, type UserRef } from '@adonis-agora/context'

function baggageFor(tenantId: string, { type, id }: UserRef) {
  return encodeBaggage({
    tenantId,
    userRef: encodeUserRef({ type, id }), // percent-encoded per W3C rules
  })
}
```

Mechanism: baggage values must be percent-encoded; raw concatenation produces
invalid headers for values containing `,` `=` `%`. The exported codecs are the
exact primitives `toBaggage` uses internally, and `decodeBaggage` tolerates
malformed members rather than throwing. Source: `docs/cross-process.mdx`
(low-level codecs table), `packages/core/src/baggage.ts`.

See also: context-basics/SKILL.md — establishing and reading the store;
context-customization/SKILL.md — tuning what travels (`carrier`, `baggage`,
`serialize`/`deserialize` overrides) and the globalThis slots durable reads.
