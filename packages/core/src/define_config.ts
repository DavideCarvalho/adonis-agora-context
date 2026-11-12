import type { HttpContext } from '@adonisjs/core/http';
import type { BaggageKeyMap } from './baggage.js';
import type { ContextCarrier, ContextEnricher, ContextStore } from './context.js';
import type { TenancyConfig } from './tenancy.js';

/**
 * The shape of `config/context.ts` — the AdonisJS counterpart of the NestJS
 * `ContextModule.forRoot` options. Split conceptually into:
 *
 * - **population** (`traceHeader`, `traceId`, `initialize`, `enrichers`) — read
 *   by {@link ContextMiddleware} on every request to seed the store.
 * - **cross-boundary** (`carrier`, `serialize`, `deserialize`, `baggage`) —
 *   pushed onto the module-level singleton via `Context.configure`, so it works
 *   in queue workers / durable / ace commands too.
 *
 * Everything is optional; the defaults are sane (W3C `traceparent` in, random
 * trace id when absent, carrier of `traceId`+`tenantId`+`userRef`).
 */
export interface ContextConfig {
  // — population —

  /**
   * Header to read the incoming trace id from. Defaults to the W3C
   * `traceparent`. When absent or malformed, a fresh trace id is generated.
   */
  traceHeader?: string;

  /**
   * Override how the trace id is produced for a request. When provided, its
   * return value wins over the `traceHeader`/random default.
   */
  traceId?: (ctx: HttpContext) => string;

  /**
   * Extra fields merged into the initial store at request start. Lets the app
   * pre-populate custom (module-augmented) fields, `tenantId`, etc. `userRef`
   * still typically enters later via `Context.set()` after authentication.
   */
  initialize?: (ctx: HttpContext) => Partial<ContextStore>;

  /**
   * Eager enrichers run by the middleware right after it enters the context (and
   * after `initialize`), to populate DERIVED store fields — e.g. a `displayName`
   * from `tenantId`. Each enricher sees the assembled store and may return a
   * `Partial<ContextStore>` to merge, or mutate the store in place. For values
   * better computed on demand, prefer `Context.lazy`. Also pushed onto the
   * singleton so non-HTTP entrypoints can call `Context.runEnrichers()`.
   */
  enrichers?: ContextEnricher[];

  // — cross-boundary —

  /**
   * Which store fields `Context.serialize()` includes in the carrier. Defaults
   * to `['traceId', 'tenantId', 'userRef']`. Add custom (module-augmented)
   * fields here so they survive the queue/durable boundary.
   */
  carrier?: (keyof ContextStore)[];

  /** Full override of how the store is serialized to a carrier. */
  serialize?: (store: ContextStore) => ContextCarrier;

  /** Full override of how a carrier is re-hydrated into a store. */
  deserialize?: (carrier: ContextCarrier) => ContextStore;

  /**
   * Baggage key mapping for `Context.toBaggage()`/`Context.fromBaggage()` — the
   * standards-compliant W3C `baggage` propagation option. Defaults to the field
   * names (`tenantId`, `userRef`); set a custom key to namespace it, or `false`
   * to never propagate that field over baggage. Independent of the bespoke
   * carrier above.
   */
  baggage?: BaggageKeyMap;

  // — tenancy —

  /**
   * Scope data by the active tenant (organization) across every Agora lib.
   * Off by default: nothing changes until `enabled: true`. When on, the
   * tenant always rides the carrier, even if `carrier` does not list it.
   */
  tenancy?: TenancyConfig;
}

/**
 * Identity helper that gives `config/context.ts` full type-checking and
 * inference. Mirrors AdonisJS's own `defineConfig` convention.
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/context'
 * export default defineConfig({ traceHeader: 'traceparent' })
 * ```
 */
export function defineConfig(config: ContextConfig): ContextConfig {
  return config;
}

/**
 * The resolved per-request (population) options the middleware reads. Kept in a
 * module-level holder — set once by {@link ContextProvider} at boot — rather
 * than injected, mirroring the "singleton lives outside the container" stance of
 * the core: the middleware needs no constructor wiring and stays trivially
 * unit-testable. The cross-boundary subset of the same config is handed to
 * `Context.configure` separately.
 */
let httpOptions: ContextConfig = {};

/** Install the resolved config so the middleware can read its population hooks. */
export function setContextHttpOptions(options: ContextConfig): void {
  httpOptions = options;
}

/** The population options the middleware reads. Empty until the provider boots. */
export function getContextHttpOptions(): ContextConfig {
  return httpOptions;
}

/** Reset the population options to empty. Primarily for tests. */
export function resetContextHttpOptions(): void {
  httpOptions = {};
}
