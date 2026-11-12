import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { Context, type ContextStore, syncTenantFields } from './context.js';
import { getContextHttpOptions } from './define_config.js';
import { parseTraceparent, randomTraceId } from './traceparent.js';

/**
 * Establishes the per-request context at the very start of the pipeline.
 *
 * Registered on the **server** middleware stack (runs on every request, before
 * route resolution). Uses `enterWith` (not `run`) so the context survives the
 * middleware return and reaches the async handler and downstream middleware.
 * `userRef`/`tenantId` are filled in later (e.g. after auth) via `Context.set()`.
 */
export default class ContextMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const options = getContextHttpOptions();
    const headers = ctx.request.headers();
    const traceHeader = options.traceHeader ?? 'traceparent';
    // Parse the upstream traceparent once: its trace-id seeds ours (unless a
    // `traceId` hook overrides), and its span-id + flags are kept so we can
    // re-emit a faithful downstream traceparent. See toTraceparent.
    const upstream = parseTraceparent(headers, traceHeader);
    const traceId = options.traceId?.(ctx) ?? upstream?.traceId ?? randomTraceId();
    // AdonisJS request id (enabled via `generateRequestId` in config/app.ts).
    const requestId = ctx.request.id();

    // Precedence: merge the loosely-typed `initialize()` bag FIRST, then set the
    // dedicated `traceId`/`requestId` LAST so the resolved trace-id (hook →
    // header → random) and request-id always win and can never be clobbered by
    // a stray field in `initialize()`'s return.
    const store: ContextStore = { traceId };
    const extra = options.initialize?.(ctx);
    if (extra) {
      Object.assign(store, extra);
      store.traceId = traceId;
    }
    if (requestId) {
      store.requestId = requestId;
    }
    // Keep the upstream span-id/flags only when our trace-id is genuinely the
    // upstream one (no `traceId` hook re-rooted the trace).
    if (upstream && upstream.traceId === traceId) {
      store.traceparent = upstream;
    }

    syncTenantFields(store);
    Context.enterWith(store);

    // Eager enrichers: derive fields from the now-assembled store right after
    // entering the context. A throwing enricher is isolated and never breaks the
    // request or the other enrichers.
    const enrichers = options.enrichers;
    if (enrichers && enrichers.length > 0) {
      for (const enricher of enrichers) {
        try {
          const patch = enricher(store, ctx);
          if (patch) {
            Object.assign(store, patch);
          }
        } catch {
          // An enricher must never break the request or the other enrichers.
        }
      }
      syncTenantFields(store);
    }

    return next();
  }
}
