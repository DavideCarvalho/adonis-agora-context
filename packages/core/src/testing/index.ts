import { Context, type ContextStore, syncTenantFields } from '../context.js';
import { randomTraceId } from '../traceparent.js';

/** Everything but `traceId` is optional; `traceId` is auto-filled when omitted. */
export type PartialContextStore = Partial<ContextStore>;

function withDefaults(partial: PartialContextStore): ContextStore {
  const { traceId, ...rest } = partial;
  return syncTenantFields({ traceId: traceId ?? randomTraceId(), ...rest });
}

/**
 * Run `fn` inside a fake context store. Any omitted field defaults sensibly
 * (`traceId` gets a random W3C-shaped id), so tests can set only what they care
 * about:
 *
 * ```ts
 * runWithContext({ tenantId: 't1', userRef: { type: 'user', id: 7 } }, () => {
 *   expect(Context.tenantId()).toBe('t1');
 * });
 * ```
 */
export function runWithContext<T>(partial: PartialContextStore, fn: () => T): T {
  return Context.run(withDefaults(partial), fn);
}

/**
 * Like {@link runWithContext} but uses `enterWith`, so the fake context survives
 * past the call without a callback scope — useful when the code under test reads
 * the context after the setup returns (e.g. across an `await`).
 */
export function enterContext(partial: PartialContextStore): void {
  Context.enterWith(withDefaults(partial));
}
