import { Exception } from '@adonisjs/core/exceptions';

/**
 * Where a {@link TenantRef} came from. Libs may use it to decide how much to
 * trust a tenant (e.g. ignore `baggage`-sourced tenants from the network).
 *
 * - `authkit`: published by `@adonis-agora/authkit-client` from a verified token.
 * - `app`: set by application code (`Context.setTenant`, `Context.withTenant`).
 * - `carrier`: restored from a queue/durable/process carrier.
 * - `baggage`: restored from a W3C `baggage` header (only with `trustBaggage`).
 * - `personal`: derived from the signed-in user (`tenancy.personal`).
 * - `legacy`: only a plain `tenantId` was written (no kind known).
 */
export type TenantSource =
  | 'authkit'
  | 'app'
  | 'carrier'
  | 'baggage'
  | 'personal'
  | 'legacy'
  | (string & {});

/** One level of a tenant hierarchy, e.g. a clinic, or a unit inside it. */
export interface TenantLevel {
  /** Stable key. Libs stamp and compare rows by this id. */
  id: string;
  /** What this level is: `'organization'`, `'user'`, `'clinic'`, `'unit'`, … */
  kind: 'organization' | 'user' | 'unknown' | (string & {});
  /** Display only, never a key. */
  slug?: string;
  /** The caller's role inside this tenant (e.g. authkit `orgRole`). Display / authz input only. */
  role?: string;
}

/**
 * The active tenant: the customer (organization, clinic, account, …) the data
 * of this request belongs to. When tenants nest, it is the most specific level
 * and `chain` holds the whole active path (outermost first, this one last), so a
 * lib configured for an upper level (`kinds: ['clinic']`) can scope by it.
 */
export interface TenantRef extends TenantLevel {
  source: TenantSource;
  /**
   * The active path when tenants nest, outermost first and this tenant last
   * (e.g. `[clinic, unit]`). Absent for a flat tenant.
   */
  chain?: TenantLevel[];
  /**
   * Name of the tenant family when a request carries more than one (e.g. a
   * patient's `account` next to the `clinic` chain). Unset on the primary tenant
   * unless the app names it.
   */
  family?: string;
}

/** What `Context.setTenant` / `Context.withTenant` accept: `source` defaults to `'app'`. */
export type TenantInput = Omit<TenantRef, 'source' | 'id'> & {
  id: string | number;
  source?: TenantSource;
};

/** Options for `Context.setTenant` / `Context.withTenant`. */
export interface SetTenantOptions {
  /**
   * Write a secondary tenant family instead of the primary tenant. The primary
   * tenant is the one `tenantId` mirrors.
   */
  family?: string;
}

/** Resolves display labels for tenant ids (console pickers, reports). */
export type TenantLabelResolver = (
  ids: string[],
  info: { kind?: string },
) => Record<string, string> | Promise<Record<string, string>>;

/** The `tenancy` block of `config/context.ts`. */
export interface TenancyConfig {
  /**
   * The single switch. `true` makes every lib whose own `tenancy` option is
   * `'inherit'` (the default) scope its data by the active tenant, and always
   * carries the tenant across queue/durable/process boundaries.
   * @default false
   */
  enabled?: boolean;
  /** Allow-list of tenant kinds libs honour. A tenant of another kind is treated as no tenant. */
  kinds?: string[];
  /**
   * Make a missing tenant an error: a lib that needs a tenant throws
   * {@link TenantRequiredError} instead of using the shared no-tenant pool.
   * @default false
   */
  required?: boolean;
  /**
   * With no active tenant, use the signed-in user as a `kind: 'user'` tenant
   * (personal workspaces).
   * @default false
   */
  personal?: boolean;
  /**
   * Accept a tenant from an incoming W3C `baggage` header. Only enable behind a
   * trusted gateway / for service-to-service calls.
   * @default false
   */
  trustBaggage?: boolean;
  /** Display labels for tenant ids, used by consoles. */
  label?: TenantLabelResolver;
}

/** {@link TenancyConfig} with defaults applied. */
export interface ResolvedTenancy {
  enabled: boolean;
  kinds?: string[];
  required: boolean;
  personal: boolean;
  trustBaggage: boolean;
}

/** How a lib must scope a read or write right now. */
export type TenantFilter =
  /** No active context (boot, internal workers, ace without `withTenant`): do not filter. */
  | { mode: 'system' }
  /** Inside `Context.allTenants()`: see every tenant, including rows with no tenant. */
  | { mode: 'all' }
  /** A context with no (matching) tenant: only rows with no tenant. */
  | { mode: 'tenantless' }
  /** A context with a tenant: only that tenant's rows; stamp writes with `tenant.id`. */
  | { mode: 'tenant'; tenant: TenantRef; chain: TenantLevel[] };

/** Options a lib passes to `tenantFilter()`. */
export interface TenantFilterOptions {
  /** The lib's own allow-list. Falls back to `tenancy.kinds` from `config/context.ts`. */
  kinds?: string[];
  /** Only consider this tenant family. */
  family?: string;
  /** Throw {@link TenantRequiredError} when there is no matching tenant. Falls back to `tenancy.required`. */
  required?: boolean;
}

/**
 * Thrown when a tenant is required (`tenancy.required`, or a lib/app asking via
 * `Context.requireTenant()`) and the current context has none.
 */
export class TenantRequiredError extends Exception {
  static override status = 403;
  static override code = 'E_TENANT_REQUIRED';

  constructor(
    message = 'This action needs an active tenant (organization). Select one and retry.',
  ) {
    super(message);
  }
}

export function resolveTenancy(config: TenancyConfig | undefined): ResolvedTenancy {
  const resolved: ResolvedTenancy = {
    enabled: config?.enabled === true,
    required: config?.required === true,
    personal: config?.personal === true,
    trustBaggage: config?.trustBaggage === true,
  };
  if (config?.kinds !== undefined) {
    resolved.kinds = [...config.kinds];
  }
  return resolved;
}

function cleanLevel(level: TenantLevel): TenantLevel {
  const out: TenantLevel = { id: String(level.id), kind: level.kind || 'unknown' };
  if (level.slug !== undefined) out.slug = level.slug;
  if (level.role !== undefined) out.role = level.role;
  return out;
}

/** Validate and normalize what the app passed into a stored {@link TenantRef}. */
export function toTenantRef(input: TenantInput, fallbackSource: TenantSource = 'app'): TenantRef {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(
      '[@adonis-agora/context] A tenant must be an object with an `id` and a `kind`.',
    );
  }
  const id = input.id === undefined || input.id === null ? '' : String(input.id);
  if (id === '') {
    throw new TypeError('[@adonis-agora/context] A tenant needs a non-empty `id`.');
  }
  const ref: TenantRef = {
    id,
    kind: input.kind || 'unknown',
    source: input.source ?? fallbackSource,
  };
  if (input.slug !== undefined) ref.slug = input.slug;
  if (input.role !== undefined) ref.role = input.role;
  if (input.family !== undefined) ref.family = input.family;
  if (input.chain !== undefined && input.chain.length > 0) {
    const chain = input.chain.map(cleanLevel);
    const last = chain[chain.length - 1] as TenantLevel;
    if (last.id !== ref.id || last.kind !== ref.kind) {
      chain.push(cleanLevel(ref));
    }
    if (chain.length > 1) {
      ref.chain = chain;
    }
  }
  return ref;
}

/** A tenant known only by a plain `tenantId` (old writers, `initialize`, carriers). */
export function legacyTenant(id: string): TenantRef {
  return { id, kind: 'unknown', source: 'legacy' };
}

/** The active path of a ref, outermost first (a flat tenant is a chain of one). */
export function chainOf(ref: TenantRef): TenantLevel[] {
  if (ref.chain !== undefined && ref.chain.length > 0) {
    return ref.chain.map(cleanLevel);
  }
  return [cleanLevel(ref)];
}

/**
 * Pick the level a lib scopes by. Walks each ref from the most specific level up
 * to the outermost and returns the first one whose kind is allowed (any kind
 * when `kinds` is unset), as a {@link TenantRef} of its own with the chain cut
 * at that level.
 */
export function matchTenant(
  refs: TenantRef[],
  kinds: string[] | undefined,
  family: string | undefined,
): { tenant: TenantRef; chain: TenantLevel[] } | undefined {
  for (const ref of refs) {
    if (family !== undefined && ref.family !== family) continue;
    const chain = chainOf(ref);
    if (kinds === undefined) {
      return { tenant: ref, chain };
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const level = chain[i] as TenantLevel;
      if (!kinds.includes(level.kind)) continue;
      if (i === chain.length - 1) {
        return { tenant: ref, chain };
      }
      const cut = chain.slice(0, i + 1);
      const tenant: TenantRef = { ...level, source: ref.source };
      if (ref.family !== undefined) tenant.family = ref.family;
      if (cut.length > 1) tenant.chain = cut;
      return { tenant, chain: cut };
    }
  }
  return undefined;
}
