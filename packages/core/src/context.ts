import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type BaggageKeyMap,
  decodeBaggage,
  decodeUserRef,
  encodeBaggage,
  encodeUserRef,
  resolveBaggageKeys,
} from './baggage.js';
import {
  chainOf,
  legacyTenant,
  matchTenant,
  type ResolvedTenancy,
  resolveTenancy,
  type SetTenantOptions,
  type TenancyConfig,
  type TenantFilter,
  type TenantFilterOptions,
  type TenantInput,
  type TenantLabelResolver,
  type TenantLevel,
  type TenantRef,
  TenantRequiredError,
  toTenantRef,
} from './tenancy.js';
import { extractTraceparent, type ParsedTraceparent, randomTraceId } from './traceparent.js';

/**
 * Stable reference to a principal — `{ type, id }`, never the full user object.
 * Keeping a ref (not the entity) is what makes the store serializable across
 * boundaries (queue, durable worker, sub-process). See DESIGN §2/§5.
 */
export interface UserRef {
  type: string;
  id: string | number;
}

/**
 * The per-request context held in the module-level AsyncLocalStorage.
 *
 * Open for extension via module augmentation — other ecosystem libs add fields:
 *
 * ```ts
 * declare module '@adonis-agora/context' {
 *   interface ContextStore {
 *     locale?: string;
 *   }
 * }
 * ```
 */
export interface ContextStore {
  traceId: string;
  requestId?: string;
  userRef?: UserRef;
  /**
   * The active tenant id. Always equal to `tenant.id` when a tenant is set:
   * writing either one keeps the other in sync.
   */
  tenantId?: string;
  /**
   * The active tenant (most specific level; `chain` holds the nested path).
   * Write it with {@link Context.setTenant}; read it with {@link Context.tenant}.
   */
  tenant?: TenantRef;
  /** Tenants of other families active in this request (each with a `family`). */
  tenantFamilies?: TenantRef[];
  /** `'all'` only inside {@link Context.allTenants}: libs do not narrow by tenant. */
  tenantScope?: 'all';
  /**
   * The parsed upstream `traceparent` (span-id + trace-flags), captured at
   * request start. Lets a re-emitted `traceparent` faithfully continue the
   * distributed trace — propagating the parent span-id and the upstream
   * sampling decision — instead of fabricating a new one. Process-local only:
   * intentionally NOT part of the default cross-process carrier. See
   * {@link toTraceparent}.
   */
  traceparent?: ParsedTraceparent;
}

/**
 * Plain, serializable snapshot of the context safe to send across a process /
 * queue / durable boundary. Carries no user entity nor DB connection — just the
 * refs needed to re-hydrate on the other side. See DESIGN §5.
 */
export interface ContextCarrier {
  traceId: string;
  tenantId?: string;
  /** Present when tenancy is enabled (or listed in `carrier`). */
  tenant?: TenantRef;
  /** Present when tenancy is enabled and the request has more than one tenant family. */
  tenantFamilies?: TenantRef[];
  userRef?: UserRef;
}

/**
 * Module-level singleton store. Lives outside the DI container on purpose so it
 * can be read from places Nest cannot inject into: ORM subscribers, queue
 * workers, the durable worker, plain functions. Mirrors `telescope-context.ts`
 * and `filterAls` from the sibling libs.
 */
const als = new AsyncLocalStorage<ContextStore>();

/**
 * An enricher: a function that populates derived values onto the active context.
 * Run eagerly by {@link Context.runEnrichers} (the middleware calls it right
 * after entering the context).
 *
 * Both styles are supported and can be mixed freely:
 *
 * - return a `Partial<ContextStore>`, which is merged into the store;
 * - or mutate the passed `store` directly and return nothing.
 *
 * The optional `req` is whatever the caller forwarded — the AdonisJS
 * `HttpContext` when the middleware runs the enrichers, and whatever was passed
 * to `Context.runEnrichers(req)` otherwise. It is typed `unknown` because the
 * store is also populated outside HTTP, so narrow it before use.
 *
 * Errors thrown by one enricher are swallowed so they never break the request or
 * the other enrichers.
 */
// The `void` in the return union is load-bearing: it is what makes a mutate-in-place
// enricher (a body that assigns onto `store` and returns nothing) assignable to this
// type. Narrowing it back to `undefined` breaks that documented style with TS2322 —
// see test/fixtures/enricher_types.ts, which type-checks every accepted shape.
// biome-ignore lint/suspicious/noConfusingVoidType: see the note above.
export type ContextEnricher = (store: ContextStore, req?: unknown) => Partial<ContextStore> | void;

/**
 * Configures the cross-boundary behaviour of the singleton. Comes from
 * `ContextModule.forRoot` (DI) but lands here once at module init via
 * {@link Context.configure}, because the singleton lives outside the container.
 * See DESIGN §4.1 level 4.
 */
export interface ContextConfig {
  /** Store fields included by the default {@link Context.serialize}. */
  carrier?: (keyof ContextStore)[];
  /** Full override of {@link Context.serialize}. */
  serialize?: (store: ContextStore) => ContextCarrier;
  /** Full override of {@link Context.deserialize}'s carrier→store step. */
  deserialize?: (carrier: ContextCarrier) => ContextStore;
  /**
   * Baggage key mapping for {@link Context.toBaggage}/{@link Context.fromBaggage}
   * — the standards-compliant W3C `baggage` propagation option. Defaults to the
   * field names (`tenantId`, `userRef`); set a custom key to namespace it, or
   * `false` to never propagate that field over baggage. Independent of the
   * bespoke {@link ContextCarrier} path, which is unaffected.
   */
  baggage?: BaggageKeyMap;
  /**
   * Eager enrichers run by {@link Context.runEnrichers} (which the middleware
   * calls right after entering the context) to populate derived store fields —
   * e.g. a `displayName` derived from `tenantId`, a region from a header. For
   * values better computed on first use, prefer the lazy {@link Context.lazy}.
   */
  enrichers?: ContextEnricher[];
  /** Tenancy switch and options. See `config/context.ts` → `tenancy`. */
  tenancy?: TenancyConfig;
}

/**
 * Module-level config. Empty until `forRoot` calls {@link Context.configure},
 * so `serialize`/`deserialize` keep their default behaviour out of the box.
 *
 * PROCESS-GLOBAL: this is shared across every `ContextModule.forRoot` in the
 * process. In multi-app (one process hosting several Nest apps) or multi-test
 * scenarios, call {@link Context.resetConfig} between apps/tests so one app's
 * carrier/serialize/deserialize never bleeds into another. See DESIGN §4.1.
 */
let config: ContextConfig = {};

/** Whether {@link Context.configure} has already set a non-empty config. */
let configured = false;

/** {@link ContextConfig.tenancy} with defaults applied. Recomputed on configure. */
let tenancy: ResolvedTenancy = resolveTenancy(undefined);

/** Label resolver registered at runtime (e.g. by authkit). `tenancy.label` wins over it. */
let registeredLabeler: TenantLabelResolver | undefined;

function configsConflict(a: ContextConfig, b: ContextConfig): boolean {
  const carrierA = JSON.stringify(a.carrier);
  const carrierB = JSON.stringify(b.carrier);
  const baggageA = JSON.stringify(a.baggage);
  const baggageB = JSON.stringify(b.baggage);
  return (
    carrierA !== carrierB ||
    baggageA !== baggageB ||
    a.serialize !== b.serialize ||
    a.deserialize !== b.deserialize ||
    JSON.stringify(a.tenancy) !== JSON.stringify(b.tenancy) ||
    a.tenancy?.label !== b.tenancy?.label ||
    // Enrichers are function arrays — compare by reference (same approach as the
    // serialize/deserialize fns): a distinct array is treated as a config change.
    a.enrichers !== b.enrichers
  );
}

/** One-shot guard so the missing-traceId warning is not spammed per request. */
let warnedMissingTraceId = false;

/** One-shot guard so the out-of-context `set` warning is not spammed. */
let warnedSetOutsideContext = false;

export function ensureTraceId(store: ContextStore): ContextStore {
  // A cross-process carrier may arrive missing/empty `traceId` (e.g. produced by
  // a different runtime). The ContextStore.traceId invariant is `string`, so we
  // synthesize one rather than propagate `undefined` (which breaks telescope/
  // durable correlation). See P9 / DESIGN §5.
  if (!store.traceId) {
    if (!warnedMissingTraceId) {
      warnedMissingTraceId = true;
      console.warn(
        '[@adonis-agora/context] Received a carrier with no traceId; generating a ' +
          'fresh one to preserve the ContextStore.traceId invariant.',
      );
    }
    store.traceId = randomTraceId();
  }
  return store;
}

function fromCarrier(carrier: ContextCarrier): ContextStore {
  if (config.deserialize) {
    const custom = ensureTraceId(config.deserialize(carrier));
    // With tenancy on the tenant always crosses the boundary, even through a
    // custom `deserialize` that does not know about it.
    if (tenancy.enabled && custom.tenantId === undefined && custom.tenant === undefined) {
      if (carrier.tenant !== undefined) {
        custom.tenant = asCarried(carrier.tenant);
      } else if (carrier.tenantId !== undefined) {
        custom.tenantId = carrier.tenantId;
      }
    }
    if (
      tenancy.enabled &&
      custom.tenantFamilies === undefined &&
      Array.isArray(carrier.tenantFamilies)
    ) {
      custom.tenantFamilies = carrier.tenantFamilies.map(asCarried);
    }
    return syncTenantFields(custom);
  }
  const store: ContextStore = { traceId: carrier.traceId };
  if (carrier.tenantId !== undefined) {
    store.tenantId = carrier.tenantId;
  }
  if (carrier.userRef !== undefined) {
    store.userRef = carrier.userRef;
  }
  if (carrier.tenant !== undefined) {
    store.tenant = asCarried(carrier.tenant);
  }
  if (Array.isArray(carrier.tenantFamilies)) {
    store.tenantFamilies = carrier.tenantFamilies.map(asCarried);
  }
  return syncTenantFields(ensureTraceId(store));
}

/** A tenant restored from a carrier: same tenant, `source: 'carrier'`. */
function asCarried(ref: TenantRef): TenantRef {
  return ref !== null && typeof ref === 'object' ? { ...ref, source: 'carrier' } : ref;
}

/**
 * Keep `tenantId` and `tenant` consistent on a store assembled in bulk (by the
 * middleware's `initialize`, a carrier, a snapshot): a `tenant` without a
 * `tenantId` fills it; a `tenant` that disagrees with `tenantId` is dropped (the
 * plain id wins and reads as a `legacy` tenant).
 */
export function syncTenantFields(store: ContextStore): ContextStore {
  const ref = store.tenant;
  if (ref !== undefined) {
    if (ref === null || typeof ref !== 'object' || typeof ref.id !== 'string') {
      delete store.tenant;
    } else if (store.tenantId === undefined) {
      store.tenantId = ref.id;
    } else if (store.tenantId !== ref.id) {
      delete store.tenant;
    }
  }
  return store;
}

/** Resolve the primary tenant of a store (see {@link Context.tenant}). */
function primaryTenant(store: ContextStore): TenantRef | undefined {
  const ref = store.tenant;
  const id = store.tenantId;
  if (ref !== undefined && (id === undefined || ref.id === id)) {
    return ref;
  }
  if (id !== undefined && id !== '') {
    return legacyTenant(String(id));
  }
  if (tenancy.enabled && tenancy.personal && store.userRef !== undefined) {
    return { id: String(store.userRef.id), kind: 'user', source: 'personal' };
  }
  return undefined;
}

function allTenantsOf(store: ContextStore): TenantRef[] {
  const primary = primaryTenant(store);
  const families = store.tenantFamilies ?? [];
  return primary === undefined ? [...families] : [primary, ...families];
}

/** The tenant fields the carrier always carries once tenancy is enabled. */
function addTenantToCarrier(store: ContextStore, carrier: ContextCarrier): ContextCarrier {
  if (!tenancy.enabled) {
    return carrier;
  }
  if (carrier.tenantId === undefined && store.tenantId !== undefined) {
    carrier.tenantId = store.tenantId;
  }
  if (carrier.tenant === undefined && store.tenant !== undefined) {
    carrier.tenant = store.tenant;
  }
  if (
    carrier.tenantFamilies === undefined &&
    store.tenantFamilies !== undefined &&
    store.tenantFamilies.length > 0
  ) {
    carrier.tenantFamilies = store.tenantFamilies;
  }
  return carrier;
}

const SYSTEM_FILTER: TenantFilter = Object.freeze({ mode: 'system' });
const ALL_FILTER: TenantFilter = Object.freeze({ mode: 'all' });
const TENANTLESS_FILTER: TenantFilter = Object.freeze({ mode: 'tenantless' });

function warnSetOutsideContext(what: string): void {
  if (!warnedSetOutsideContext) {
    warnedSetOutsideContext = true;
    console.warn(
      `[@adonis-agora/context] ${what} was called with no active context, so it was a no-op and the value was dropped. This usually means the code (e.g. an auth guard) ran on a path the ContextMiddleware did not cover, or outside any Context.run/enterWith scope. Ensure the context is established first. This warning fires once per process.`,
    );
  }
}

/** Apply a tenant write to a store (primary or a named family). */
function writeTenant(
  store: ContextStore,
  input: TenantInput | null | undefined,
  family: string | undefined,
): void {
  if (family !== undefined) {
    const others = (store.tenantFamilies ?? []).filter((ref) => ref.family !== family);
    if (input) {
      others.push(toTenantRef({ ...input, family }));
    }
    if (others.length > 0) {
      store.tenantFamilies = others;
    } else {
      delete store.tenantFamilies;
    }
    return;
  }
  if (input) {
    const ref = toTenantRef(input);
    store.tenant = ref;
    store.tenantId = ref.id;
  } else {
    delete store.tenant;
    delete store.tenantId;
  }
}

function defaultSerialize(store: ContextStore): ContextCarrier {
  const fields = config.carrier;
  // Fast path: the default carrier (no `config.carrier` override) is the common
  // case, so hand-roll it and skip the per-iteration `traceId` filter + loose
  // Record. Behaviour is identical to the generic loop over the former
  // default carrier `['traceId', 'tenantId', 'userRef']`.
  if (fields === undefined) {
    const c: ContextCarrier = { traceId: store.traceId };
    if (store.tenantId !== undefined) {
      c.tenantId = store.tenantId;
    }
    if (store.userRef !== undefined) {
      c.userRef = store.userRef;
    }
    return addTenantToCarrier(store, c);
  }
  // `traceId` is always present on a carrier.
  const carrier: Record<string, unknown> = { traceId: store.traceId };
  for (const field of fields) {
    if (field === 'traceId' || field === 'tenantScope') {
      continue;
    }
    const value = store[field];
    if (value !== undefined) {
      carrier[field] = value;
    }
  }
  return addTenantToCarrier(store, carrier as unknown as ContextCarrier);
}

export const Context = {
  /** Run `fn` with `store` as the active context for `fn` and its descendants. */
  run<T>(store: ContextStore, fn: () => T): T {
    return als.run(store, fn);
  },

  /**
   * Establish `store` as the active context for the current async execution and
   * all its descendants, WITHOUT a callback scope. Used by the middleware so the
   * context survives the middleware return and reaches the async handler,
   * guards, and interceptors. See DESIGN §3.
   */
  enterWith(store: ContextStore): void {
    als.enterWith(store);
  },

  /** The active store, or `undefined` outside any context. Never throws. */
  get(): ContextStore | undefined {
    return als.getStore();
  },

  /**
   * Mutate a field on the active store (e.g. the auth guard sets `userRef`
   * after the middleware already entered the context).
   *
   * Outside an active context this is a no-op that never throws (other Agora
   * libs write through the `CONTEXT_SET` slot best-effort), but it emits a
   * one-shot `console.warn`, because a silently
   * dropped `set` is a common footgun: e.g. an auth guard calls
   * `Context.set('userRef', …)` on a route the middleware was excluded from, so
   * the value is lost without a trace. The warning fires once per process; call
   * {@link Context.resetSetWarning} to re-arm it (primarily for tests).
   */
  set<K extends keyof ContextStore>(key: K, value: ContextStore[K]): void {
    const store = als.getStore();
    if (store) {
      if (key === 'tenant') {
        // Writing `tenant` keeps `tenantId` in sync (and validates the ref).
        writeTenant(store, value as TenantInput | undefined, undefined);
        return;
      }
      if (key === 'tenantId') {
        // A plain id from an older writer: drop a `tenant` that no longer matches,
        // so `Context.tenant()` reads it back as a `legacy` tenant.
        if (value === undefined || value === null) {
          delete store.tenantId;
          delete store.tenant;
          return;
        }
        store.tenantId = value as string;
        if (store.tenant !== undefined && store.tenant.id !== value) {
          delete store.tenant;
        }
        return;
      }
      store[key] = value;
      return;
    }
    warnSetOutsideContext(`Context.set(${String(key)}, …)`);
  },

  /** Re-arm the one-shot out-of-context `set` warning. Primarily for tests. */
  resetSetWarning(): void {
    warnedSetOutsideContext = false;
  },

  /**
   * Snapshot the active context and return a wrapped `fn` that re-enters that
   * snapshot every time it is later invoked — even outside any context. Mirrors
   * `AsyncResource.bind` / nestjs-cls's snapshot helpers, and is the safe way to
   * carry context across boundaries AsyncLocalStorage does not follow on its
   * own: `setTimeout`/`setInterval`, `EventEmitter` listeners, and queue/job
   * callbacks registered now but run later.
   *
   * Captures whatever is active at bind time (possibly nothing — then the bound
   * fn runs with no active store). Arguments, `this`, and the return value all
   * pass through unchanged.
   *
   * ```ts
   * emitter.on('done', Context.bind(() => log(Context.traceId())));
   * setTimeout(Context.bind(handler), 1000);
   * ```
   */
  bind<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const snapshot = als.getStore();
    if (snapshot === undefined) {
      return fn;
    }
    return function (this: unknown, ...args: A): R {
      return als.run(snapshot, () => fn.apply(this, args));
    };
  },

  traceId(): string | undefined {
    return als.getStore()?.traceId;
  },

  /** The active tenant id (`tenant().id`), or `undefined`. */
  tenantId(): string | undefined {
    const store = als.getStore();
    if (!store) {
      return undefined;
    }
    if (store.tenantId !== undefined) {
      return store.tenantId;
    }
    return primaryTenant(store)?.id;
  },

  /**
   * The active tenant, or `undefined`. A store that only has a plain `tenantId`
   * reads as `{ id, kind: 'unknown', source: 'legacy' }`. With
   * `tenancy.personal`, a signed-in user with no tenant reads as
   * `{ id: userRef.id, kind: 'user', source: 'personal' }`.
   */
  tenant(): TenantRef | undefined {
    const store = als.getStore();
    return store ? primaryTenant(store) : undefined;
  },

  /** Every active tenant: the primary one first, then the other families. */
  tenants(): TenantRef[] {
    const store = als.getStore();
    return store ? allTenantsOf(store) : [];
  },

  /**
   * The active tenant chain, root first (e.g. `[clinic, unit]`). Pass a family
   * name to read another family's chain.
   */
  tenantChain(family?: string): TenantLevel[] {
    const store = als.getStore();
    if (!store) {
      return [];
    }
    const ref =
      family === undefined
        ? primaryTenant(store)
        : store.tenantFamilies?.find((candidate) => candidate.family === family);
    return ref ? chainOf(ref) : [];
  },

  /**
   * Set the active tenant on the current context (and `tenantId` with it).
   * `null` clears it. Pass `{ family }` to set a tenant of another family
   * alongside the primary one.
   *
   * ```ts
   * Context.setTenant({ id: clinic.id, kind: 'clinic' })
   * Context.setTenant({ id: unit.id, kind: 'unit', chain: [{ id: clinic.id, kind: 'clinic' }] })
   * Context.setTenant({ id: account.id, kind: 'account' }, { family: 'account' })
   * ```
   */
  setTenant(input: TenantInput | null, options?: SetTenantOptions): void {
    const store = als.getStore();
    if (!store) {
      warnSetOutsideContext('Context.setTenant(…)');
      return;
    }
    writeTenant(store, input, options?.family);
  },

  /**
   * Run `fn` with `input` as the active tenant. Works with or without an active
   * context (a fresh one is created for ace commands, seeders, webhook handlers
   * and tests). The outer context is left untouched. `null` runs `fn` with no
   * tenant.
   */
  withTenant<T>(input: TenantInput | null, fn: () => T, options?: SetTenantOptions): T {
    const base = als.getStore();
    const store: ContextStore = base ? { ...base } : { traceId: randomTraceId() };
    delete store.tenantScope;
    if (store.tenantFamilies !== undefined) {
      store.tenantFamilies = [...store.tenantFamilies];
    }
    writeTenant(store, input, options?.family);
    return als.run(store, fn);
  },

  /**
   * Run `fn` across every tenant: libs that scope by tenant see all rows,
   * including rows with no tenant. The only way around tenant scoping, so keep
   * it to admin code. Not carried into jobs dispatched from inside.
   */
  allTenants<T>(fn: () => T): T {
    const base = als.getStore();
    const store: ContextStore = base ? { ...base } : { traceId: randomTraceId() };
    store.tenantScope = 'all';
    return als.run(store, fn);
  },

  /**
   * How a lib must scope data right now. `system` (no context: do not filter),
   * `all` (inside {@link allTenants}), `tenantless` (no matching tenant) or
   * `tenant` (with the level matching `kinds`). Throws
   * {@link TenantRequiredError} instead of returning `tenantless` when a tenant
   * is required.
   */
  tenantFilter(options?: TenantFilterOptions): TenantFilter {
    const store = als.getStore();
    if (!store) {
      return SYSTEM_FILTER;
    }
    if (store.tenantScope === 'all') {
      return ALL_FILTER;
    }
    const match = matchTenant(
      allTenantsOf(store),
      options?.kinds ?? tenancy.kinds,
      options?.family,
    );
    if (match) {
      return { mode: 'tenant', tenant: match.tenant, chain: match.chain };
    }
    if (options?.required ?? (tenancy.enabled && tenancy.required)) {
      throw new TenantRequiredError();
    }
    return TENANTLESS_FILTER;
  },

  /**
   * The active tenant (matching `kinds`/`family` when given), or throw
   * {@link TenantRequiredError}. For routes and jobs that only make sense
   * inside a tenant.
   */
  requireTenant(options?: Omit<TenantFilterOptions, 'required'>): TenantRef {
    const store = als.getStore();
    const match =
      store && store.tenantScope !== 'all'
        ? matchTenant(allTenantsOf(store), options?.kinds ?? tenancy.kinds, options?.family)
        : undefined;
    if (!match) {
      throw new TenantRequiredError();
    }
    return match.tenant;
  },

  /** The resolved `tenancy` options from `config/context.ts`. */
  tenancy(): ResolvedTenancy {
    const copy: ResolvedTenancy = { ...tenancy };
    if (tenancy.kinds !== undefined) {
      copy.kinds = [...tenancy.kinds];
    }
    return copy;
  },

  /**
   * Display labels for tenant ids, from `tenancy.label` (or a resolver a lib
   * registered with {@link setTenantLabeler}). Ids without a label are absent
   * from the result; never throws.
   */
  async tenantLabels(ids: string[], kind?: string): Promise<Record<string, string>> {
    const resolver = config.tenancy?.label ?? registeredLabeler;
    if (!resolver || ids.length === 0) {
      return {};
    }
    try {
      const labels = await resolver([...ids], kind === undefined ? {} : { kind });
      return labels && typeof labels === 'object' ? { ...labels } : {};
    } catch {
      return {};
    }
  },

  /**
   * Register a label resolver (used by libs such as authkit). `tenancy.label`
   * in `config/context.ts` always wins. `undefined` unregisters it.
   */
  setTenantLabeler(resolver: TenantLabelResolver | undefined): void {
    registeredLabeler = resolver;
  },

  userRef(): UserRef | undefined {
    return als.getStore()?.userRef;
  },

  /**
   * Configure the singleton's cross-boundary behaviour (which fields the
   * carrier includes, or full serialize/deserialize overrides). Called by
   * `ContextModule.forRoot`.
   *
   * The config is **process-global** and is REPLACED wholesale on each call —
   * each `forRoot`'s options are treated as the complete carrier/serialize/
   * deserialize config, never merged. This guarantees you can never end up with
   * one app's `serialize` paired with another app's `deserialize`.
   *
   * Because it is process-global, a SECOND `forRoot` with a config that differs
   * from the first emits a `console.warn`: in multi-app or multi-test scenarios
   * the last `forRoot` wins, which is rarely what you want. Call
   * {@link Context.resetConfig} between apps/tests to silence the warning and
   * start from defaults. See DESIGN §4.1 level 4.
   */
  configure(next: ContextConfig): void {
    // Treat each forRoot's options as the COMPLETE config (replace, not merge),
    // so a mixed serialize-from-A / deserialize-from-B pair is impossible. Only
    // the carrier/serialize/deserialize keys are carried over; everything else
    // is dropped on purpose.
    const replacement: ContextConfig = {};
    if (next.carrier !== undefined) {
      replacement.carrier = next.carrier;
    }
    if (next.serialize !== undefined) {
      replacement.serialize = next.serialize;
    }
    if (next.deserialize !== undefined) {
      replacement.deserialize = next.deserialize;
    }
    if (next.baggage !== undefined) {
      replacement.baggage = next.baggage;
    }
    if (next.enrichers !== undefined) {
      replacement.enrichers = next.enrichers;
    }
    if (next.tenancy !== undefined) {
      replacement.tenancy = next.tenancy;
    }

    if (configured && configsConflict(config, replacement)) {
      console.warn(
        '[@adonis-agora/context] Context.configure() called a second time with a ' +
          'different config. The config is process-global and is replaced ' +
          'wholesale — the last forRoot wins. In multi-app or multi-test setups ' +
          'call Context.resetConfig() between apps/tests. See DESIGN §4.1.',
      );
    }

    config = replacement;
    tenancy = resolveTenancy(replacement.tenancy);
    configured = true;
  },

  /** Reset the singleton config to its defaults. Primarily for tests. */
  resetConfig(): void {
    config = {};
    tenancy = resolveTenancy(undefined);
    registeredLabeler = undefined;
    configured = false;
  },

  /**
   * Plain carrier for cross-boundary transport, or `undefined` outside any
   * context. Defaults to `{ traceId, tenantId, userRef }`; the `carrier` /
   * `serialize` options (via `configure`) tune which fields travel. The carrier
   * is a snapshot taken at call time — not a live view. See DESIGN §5.
   */
  serialize(): ContextCarrier | undefined {
    const store = als.getStore();
    if (!store) {
      return undefined;
    }
    if (config.serialize) {
      const carrier = config.serialize(store);
      return carrier ? addTenantToCarrier(store, carrier) : carrier;
    }
    return defaultSerialize(store);
  },

  /**
   * Re-hydrate a context from a carrier and run `fn` inside it. Tolerates an
   * absent carrier: when `carrier` is nullish (a job from an external producer,
   * an older job that never serialized one) `fn` runs with NO active store
   * instead of throwing — so a job that arrives without a carrier still works.
   */
  deserialize<T>(carrier: ContextCarrier | undefined, fn: () => T): T {
    if (!carrier) {
      return fn();
    }
    return als.run(fromCarrier(carrier), fn);
  },

  /**
   * Build a W3C `baggage` header value from the active context, or `undefined`
   * when there is no context or no mappable field. This is the standards-
   * compliant propagation option: instead of (or alongside) the bespoke
   * {@link ContextCarrier}, the context can ride a real `baggage` header that any
   * W3C-baggage-aware peer (OTel SDKs, gateways) understands.
   *
   * By default maps `tenantId` and `userRef` (`userRef` as a compact `type:id`
   * token); tune the keys — or disable a field — via the `baggage` config (see
   * {@link ContextConfig}). The bespoke carrier path is unaffected.
   */
  toBaggage(): string | undefined {
    const store = als.getStore();
    if (!store) {
      return undefined;
    }
    const keys = resolveBaggageKeys(config.baggage);
    const entries: Record<string, string> = {};
    if (keys.tenantId !== false && store.tenantId !== undefined) {
      entries[keys.tenantId] = store.tenantId;
      const kind = store.tenant?.kind;
      if (
        tenancy.enabled &&
        keys.tenantKind !== false &&
        kind !== undefined &&
        kind !== 'unknown'
      ) {
        entries[keys.tenantKind] = kind;
      }
    }
    if (keys.userRef !== false && store.userRef !== undefined) {
      entries[keys.userRef] = encodeUserRef(store.userRef);
    }
    const header = encodeBaggage(entries);
    return header === '' ? undefined : header;
  },

  /**
   * Re-hydrate a context from a W3C `baggage` header (the symmetric counterpart
   * of {@link toBaggage}) and run `fn` inside it. Tolerant of a malformed/absent
   * header — it simply yields a context with those fields unset.
   *
   * Baggage carries no trace-id, so the `traceId` invariant is satisfied from
   * `opts.traceparent` (a W3C `traceparent` header value, when supplied and
   * valid) else a freshly generated id — mirroring the middleware's seeding.
   */
  fromBaggage<T>(
    header: string | string[] | undefined,
    fn: () => T,
    opts?: { traceparent?: string },
  ): T {
    const keys = resolveBaggageKeys(config.baggage);
    const decoded = decodeBaggage(header);

    const traceId =
      (opts?.traceparent !== undefined
        ? extractTraceparent({ traceparent: opts.traceparent })
        : undefined) ?? randomTraceId();

    const store: ContextStore = { traceId };
    // With tenancy on, a tenant from the network is ignored unless the app opted
    // in with `trustBaggage` (e.g. behind a gateway that sets it).
    if (keys.tenantId !== false && (!tenancy.enabled || tenancy.trustBaggage)) {
      const tenantId = decoded[keys.tenantId];
      if (tenantId !== undefined && tenantId !== '') {
        store.tenantId = tenantId;
        if (tenancy.enabled) {
          const kind = keys.tenantKind === false ? undefined : decoded[keys.tenantKind];
          store.tenant = { id: tenantId, kind: kind || 'unknown', source: 'baggage' };
        }
      } else if (tenantId !== undefined) {
        store.tenantId = tenantId;
      }
    }
    if (keys.userRef !== false) {
      const token = decoded[keys.userRef];
      if (token !== undefined) {
        const userRef = decodeUserRef(token);
        if (userRef !== undefined) {
          store.userRef = userRef;
        }
      }
    }
    return als.run(store, fn);
  },

  /**
   * Run the configured eager {@link ContextConfig.enrichers} against the active
   * store, merging each one's returned `Partial<ContextStore>` (or letting it
   * mutate the store directly). The middleware calls this right after entering
   * the context, but it can also be invoked from non-HTTP entrypoints after a
   * `Context.run`/`enterWith`.
   *
   * No-op (never throws) when there is no active context or no enrichers. A
   * throwing enricher is isolated — it neither breaks the caller nor the
   * remaining enrichers.
   */
  runEnrichers(req?: unknown): void {
    const store = als.getStore();
    if (!store) {
      return;
    }
    const enrichers = config.enrichers;
    if (enrichers === undefined || enrichers.length === 0) {
      return;
    }
    for (const enricher of enrichers) {
      try {
        const patch = enricher(store, req);
        if (patch) {
          Object.assign(store, patch);
        }
      } catch {
        // An enricher must never break the request or the other enrichers.
      }
    }
  },

  /**
   * Lazily compute a derived store field on first access and memoize it onto the
   * active store, so subsequent reads (this request) are free. The on-demand
   * counterpart to eager {@link runEnrichers} — use it for values that are
   * expensive or rarely needed.
   *
   * If the field is already present on the store, its value is returned and the
   * factory is not called. Returns `undefined` outside any context (nowhere to
   * cache). The factory runs at most once per store per key.
   *
   * ```ts
   * const name = Context.lazy('displayName', (s) => lookupName(s.userRef));
   * ```
   */
  lazy<K extends keyof ContextStore>(
    key: K,
    factory: (store: ContextStore) => NonNullable<ContextStore[K]>,
  ): ContextStore[K] | undefined {
    const store = als.getStore();
    if (!store) {
      return undefined;
    }
    const existing = store[key];
    if (existing !== undefined) {
      return existing;
    }
    const value = factory(store);
    store[key] = value;
    return value;
  },
};
