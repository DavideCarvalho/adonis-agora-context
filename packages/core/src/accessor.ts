import { Context, type ContextStore, type UserRef } from './context.js';
import type {
  ResolvedTenancy,
  SetTenantOptions,
  TenantFilter,
  TenantFilterOptions,
  TenantInput,
  TenantLabelResolver,
  TenantLevel,
  TenantRef,
} from './tenancy.js';

/**
 * The read-only view of the context that consumer libs read. Intentionally a
 * narrow surface (no `set`/`run`) — consumers read, they do not drive the
 * lifecycle.
 */
export interface ContextAccessor {
  traceId(): string | undefined;
  tenantId(): string | undefined;
  userRef(): UserRef | undefined;
  /** The active tenant (see `Context.tenant`). */
  tenant(): TenantRef | undefined;
  /** Every active tenant, primary first (see `Context.tenants`). */
  tenants(): TenantRef[];
  /** The active tenant chain, root first (see `Context.tenantChain`). */
  tenantChain(family?: string): TenantLevel[];
  /** The resolved `tenancy` options of `config/context.ts`. */
  tenancy(): ResolvedTenancy;
  /** How a lib must scope data right now (see `Context.tenantFilter`). */
  tenantFilter(options?: TenantFilterOptions): TenantFilter;
  /**
   * With no argument, the whole active store (or `undefined` outside a context) —
   * what `@adonis-agora/telescope` and `@adonis-agora/resilience` read. With a key,
   * that single field off the store — what `@adonis-agora/authz` reads to pull
   * `globalRoles`. The two consumers disagreed on the shape of this slot; the
   * key-less form stays byte-identical so neither breaks.
   */
  get(): ContextStore | undefined;
  get(key: string): unknown;
}

/** Default accessor: a thin facade over the singleton {@link Context}. */
export const contextAccessor: ContextAccessor = {
  traceId: () => Context.traceId(),
  tenantId: () => Context.tenantId(),
  userRef: () => Context.userRef(),
  tenant: () => Context.tenant(),
  tenants: () => Context.tenants(),
  tenantChain: (family?: string) => Context.tenantChain(family),
  tenancy: () => Context.tenancy(),
  tenantFilter: (options?: TenantFilterOptions) => Context.tenantFilter(options),
  // Cast the single implementation onto the overloaded signature: TypeScript won't
  // infer a one-arg arrow as satisfying an overload set in an object literal.
  get: ((key?: string) => {
    const store = Context.get();
    return key === undefined ? store : store?.[key as keyof ContextStore];
  }) as ContextAccessor['get'],
};

/**
 * The cross-copy-stable global slot the ecosystem reads the accessor from. Other
 * Agora libs (e.g. `@adonis-agora/resilience` for per-tenant circuit keys) read
 * `globalThis[Symbol.for('@agora/context:accessor')]` STRUCTURALLY so they never
 * have to import `@adonis-agora/context` — they degrade to `undefined` when it is
 * absent. Published here at module load so merely importing `@adonis-agora/context`
 * (which every app that installs it does, via the provider) wires the contract.
 */
export const CONTEXT_ACCESSOR = Symbol.for('@agora/context:accessor');
(globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] = contextAccessor;

/**
 * The tenancy contract every Agora lib reads, published on
 * `globalThis[Symbol.for('@agora/context:tenancy')]`. Libs read it
 * STRUCTURALLY (never importing `@adonis-agora/context`), check `version === 1`,
 * and treat a missing slot as "tenancy off".
 *
 * Stable for 1.x: members are only ever added.
 */
export interface TenancySlot {
  readonly version: 1;
  tenancy(): ResolvedTenancy;
  tenant(): TenantRef | undefined;
  tenants(): TenantRef[];
  tenantChain(family?: string): TenantLevel[];
  tenantFilter(options?: TenantFilterOptions): TenantFilter;
  requireTenant(options?: Omit<TenantFilterOptions, 'required'>): TenantRef;
  setTenant(input: TenantInput | null, options?: SetTenantOptions): void;
  withTenant<T>(input: TenantInput | null, fn: () => T, options?: SetTenantOptions): T;
  allTenants<T>(fn: () => T): T;
  tenantLabels(ids: string[], kind?: string): Promise<Record<string, string>>;
  setTenantLabeler(resolver: TenantLabelResolver | undefined): void;
}

/** Default tenancy slot: a thin facade over the singleton {@link Context}. */
export const tenancySlot: TenancySlot = Object.freeze({
  version: 1 as const,
  tenancy: () => Context.tenancy(),
  tenant: () => Context.tenant(),
  tenants: () => Context.tenants(),
  tenantChain: (family?: string) => Context.tenantChain(family),
  tenantFilter: (options?: TenantFilterOptions) => Context.tenantFilter(options),
  requireTenant: (options?: Omit<TenantFilterOptions, 'required'>) =>
    Context.requireTenant(options),
  setTenant: (input: TenantInput | null, options?: SetTenantOptions) =>
    Context.setTenant(input, options),
  withTenant: <T>(input: TenantInput | null, fn: () => T, options?: SetTenantOptions) =>
    Context.withTenant(input, fn, options),
  allTenants: <T>(fn: () => T) => Context.allTenants(fn),
  tenantLabels: (ids: string[], kind?: string) => Context.tenantLabels(ids, kind),
  setTenantLabeler: (resolver: TenantLabelResolver | undefined) =>
    Context.setTenantLabeler(resolver),
});

/** The global slot the {@link TenancySlot} is published on. */
export const CONTEXT_TENANCY = Symbol.for('@agora/context:tenancy');
(globalThis as Record<symbol, unknown>)[CONTEXT_TENANCY] = tenancySlot;
