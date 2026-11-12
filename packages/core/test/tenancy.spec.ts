import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextProvider from '../providers/context_provider.js';
import ContextMiddleware from '../src/context_middleware.js';
import { resetContextHttpOptions, setContextHttpOptions } from '../src/define_config.js';
import {
  CONTEXT_ACCESSOR,
  CONTEXT_SCOPE,
  CONTEXT_SET,
  CONTEXT_TENANCY,
  Context,
  type ContextStore,
  contextAccessor,
  type TenancySlot,
  TenantRequiredError,
} from '../src/index.js';
import { runWithContext } from '../src/testing/index.js';

afterEach(() => {
  Context.resetConfig();
  resetContextHttpOptions();
  vi.restoreAllMocks();
});

const set = (globalThis as Record<symbol, unknown>)[CONTEXT_SET] as (
  patch: Record<string, unknown>,
) => void;
const scope = (globalThis as Record<symbol, unknown>)[CONTEXT_SCOPE] as <T>(
  snapshot: Record<string, unknown> | undefined,
  fn: () => T,
) => T;

describe('tenant contract', () => {
  it('setTenant writes tenant and tenantId together', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'org_1', kind: 'organization', slug: 'acme', role: 'owner' });
      expect(Context.tenantId()).toBe('org_1');
      expect(Context.tenant()).toEqual({
        id: 'org_1',
        kind: 'organization',
        slug: 'acme',
        role: 'owner',
        source: 'app',
      });
      Context.setTenant(null);
      expect(Context.tenantId()).toBeUndefined();
      expect(Context.tenant()).toBeUndefined();
    });
  });

  it('coerces numeric ids to strings and rejects empty ids', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 42, kind: 'clinic' });
      expect(Context.tenantId()).toBe('42');
      expect(() => Context.setTenant({ id: '', kind: 'clinic' })).toThrow(TypeError);
    });
  });

  it('a plain tenantId reads as a legacy tenant', () => {
    Context.run({ traceId: 't', tenantId: 'acme' }, () => {
      expect(Context.tenant()).toEqual({ id: 'acme', kind: 'unknown', source: 'legacy' });
    });
    Context.run({ traceId: 't' }, () => {
      set({ tenantId: 'globex' });
      expect(Context.tenant()).toEqual({ id: 'globex', kind: 'unknown', source: 'legacy' });
    });
  });

  it('a tenantId write that disagrees with the tenant drops the stale tenant', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'a', kind: 'organization' });
      Context.set('tenantId', 'b');
      expect(Context.tenant()).toEqual({ id: 'b', kind: 'unknown', source: 'legacy' });
      Context.set('tenantId', undefined);
      expect(Context.tenant()).toBeUndefined();
    });
  });

  it('the :set slot accepts a tenant patch and keeps tenantId in sync', () => {
    Context.run({ traceId: 't' }, () => {
      set({ tenant: { id: 'org_9', kind: 'organization', source: 'authkit', role: 'member' } });
      expect(Context.get()?.tenantId).toBe('org_9');
      expect(Context.tenant()?.source).toBe('authkit');
      set({ tenant: null });
      expect(Context.get()?.tenantId).toBeUndefined();
    });
  });

  it('carries a nested chain, outermost first, appending the tenant itself', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'u1', kind: 'unit', chain: [{ id: 'c1', kind: 'clinic' }] });
      expect(Context.tenant()?.chain).toEqual([
        { id: 'c1', kind: 'clinic' },
        { id: 'u1', kind: 'unit' },
      ]);
      expect(Context.tenantChain().map((level) => level.kind)).toEqual(['clinic', 'unit']);
    });
  });

  it('keeps tenants of other families next to the primary one', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'c1', kind: 'clinic' });
      Context.setTenant({ id: 'acc1', kind: 'account' }, { family: 'account' });
      expect(Context.tenantId()).toBe('c1');
      expect(Context.tenants().map((ref) => ref.id)).toEqual(['c1', 'acc1']);
      expect(Context.tenantChain('account')).toEqual([{ id: 'acc1', kind: 'account' }]);
      Context.setTenant(null, { family: 'account' });
      expect(Context.tenants().map((ref) => ref.id)).toEqual(['c1']);
    });
  });

  it('withTenant creates a context when none is active and leaves the outer one alone', () => {
    expect(Context.get()).toBeUndefined();
    const inner = Context.withTenant({ id: 'org_1', kind: 'organization' }, () => ({
      id: Context.tenantId(),
      traceId: Context.traceId(),
    }));
    expect(inner.id).toBe('org_1');
    expect(inner.traceId).toMatch(/^[0-9a-f]{32}$/);

    Context.run({ traceId: 'outer', tenantId: 'a' }, () => {
      Context.withTenant({ id: 'b', kind: 'organization' }, () => {
        expect(Context.tenantId()).toBe('b');
        expect(Context.traceId()).toBe('outer');
      });
      expect(Context.tenantId()).toBe('a');
    });
  });

  it('the personal option uses the signed-in user when there is no tenant', () => {
    Context.configure({ tenancy: { enabled: true, personal: true } });
    Context.run({ traceId: 't', userRef: { type: 'user', id: 7 } }, () => {
      expect(Context.tenant()).toEqual({ id: '7', kind: 'user', source: 'personal' });
      Context.setTenant({ id: 'org', kind: 'organization' });
      expect(Context.tenant()?.id).toBe('org');
    });
    Context.configure({ tenancy: { enabled: true } });
    Context.run({ traceId: 't', userRef: { type: 'user', id: 7 } }, () => {
      expect(Context.tenant()).toBeUndefined();
    });
  });
});

describe('tenantFilter', () => {
  it('system outside any context', () => {
    expect(Context.tenantFilter()).toEqual({ mode: 'system' });
  });

  it('tenantless with a context and no tenant', () => {
    Context.run({ traceId: 't' }, () => {
      expect(Context.tenantFilter()).toEqual({ mode: 'tenantless' });
    });
  });

  it('tenant with the active tenant and its chain', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'org', kind: 'organization' });
      expect(Context.tenantFilter()).toEqual({
        mode: 'tenant',
        tenant: { id: 'org', kind: 'organization', source: 'app' },
        chain: [{ id: 'org', kind: 'organization' }],
      });
    });
  });

  it('all inside allTenants, never carried across a boundary', () => {
    Context.configure({ tenancy: { enabled: true } });
    Context.run({ traceId: 't', tenantId: 'org' }, () => {
      Context.allTenants(() => {
        expect(Context.tenantFilter()).toEqual({ mode: 'all' });
        const carrier = Context.serialize();
        expect(carrier).not.toHaveProperty('tenantScope');
        const snapshot = contextAccessor.get() as unknown as Record<string, unknown>;
        scope(snapshot, () => {
          expect(Context.tenantFilter()).toMatchObject({ mode: 'tenant' });
        });
      });
      expect(Context.tenantFilter()).toMatchObject({ mode: 'tenant' });
    });
  });

  it('kinds picks the matching level of a chain, or none', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'u1', kind: 'unit', chain: [{ id: 'c1', kind: 'clinic' }] });
      expect(Context.tenantFilter({ kinds: ['clinic'] })).toEqual({
        mode: 'tenant',
        tenant: { id: 'c1', kind: 'clinic', source: 'app' },
        chain: [{ id: 'c1', kind: 'clinic' }],
      });
      expect(Context.tenantFilter({ kinds: ['unit'] })).toMatchObject({
        mode: 'tenant',
        tenant: { id: 'u1' },
      });
      expect(Context.tenantFilter({ kinds: ['organization'] })).toEqual({ mode: 'tenantless' });
    });
  });

  it('kinds from config/context.ts apply when the lib passes none', () => {
    Context.configure({ tenancy: { enabled: true, kinds: ['organization'] } });
    Context.run({ traceId: 't', tenantId: 'legacy-id' }, () => {
      expect(Context.tenantFilter()).toEqual({ mode: 'tenantless' });
    });
  });

  it('family selects another tenant family', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'c1', kind: 'clinic' });
      Context.setTenant({ id: 'acc1', kind: 'account' }, { family: 'account' });
      expect(Context.tenantFilter({ family: 'account' })).toMatchObject({
        mode: 'tenant',
        tenant: { id: 'acc1', family: 'account' },
      });
      expect(Context.tenantFilter({ kinds: ['account'] })).toMatchObject({
        tenant: { id: 'acc1' },
      });
    });
  });

  it('required turns tenantless into TenantRequiredError', () => {
    Context.configure({ tenancy: { enabled: true, required: true } });
    Context.run({ traceId: 't' }, () => {
      expect(() => Context.tenantFilter()).toThrow(TenantRequiredError);
      expect(() => Context.requireTenant()).toThrow(TenantRequiredError);
      Context.allTenants(() => expect(Context.tenantFilter()).toEqual({ mode: 'all' }));
    });
    expect(Context.tenantFilter()).toEqual({ mode: 'system' });
    const error = new TenantRequiredError();
    expect(error.status).toBe(403);
    expect(error.code).toBe('E_TENANT_REQUIRED');
  });

  it('required is ignored while tenancy is off, unless the lib asks', () => {
    Context.configure({ tenancy: { required: true } });
    Context.run({ traceId: 't' }, () => {
      expect(Context.tenantFilter()).toEqual({ mode: 'tenantless' });
      expect(() => Context.tenantFilter({ required: true })).toThrow(TenantRequiredError);
    });
  });
});

describe('carrier', () => {
  it('without tenancy, the default carrier stays traceId + tenantId + userRef', () => {
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'org', kind: 'organization' });
      expect(Context.serialize()).toEqual({ traceId: 't', tenantId: 'org' });
    });
  });

  it('with tenancy, the tenant rides every carrier, even one that does not list it', () => {
    Context.configure({ carrier: ['traceId', 'userRef'], tenancy: { enabled: true } });
    Context.run({ traceId: 't', userRef: { type: 'user', id: 1 } }, () => {
      Context.setTenant({ id: 'u1', kind: 'unit', chain: [{ id: 'c1', kind: 'clinic' }] });
      Context.setTenant({ id: 'acc', kind: 'account' }, { family: 'account' });
      const carrier = Context.serialize();
      expect(carrier).toMatchObject({ traceId: 't', tenantId: 'u1', tenant: { id: 'u1' } });
      expect(carrier?.tenantFamilies).toHaveLength(1);

      const json = JSON.parse(JSON.stringify(carrier));
      Context.deserialize(json, () => {
        expect(Context.tenant()).toMatchObject({ id: 'u1', kind: 'unit', source: 'carrier' });
        expect(Context.tenantChain().map((level) => level.id)).toEqual(['c1', 'u1']);
        expect(Context.tenants().map((ref) => ref.id)).toEqual(['u1', 'acc']);
      });
    });
  });

  it('with tenancy, a custom serialize/deserialize still carries the tenant', () => {
    Context.configure({
      tenancy: { enabled: true },
      serialize: (store) => ({ traceId: store.traceId }),
      deserialize: (carrier) => ({ traceId: carrier.traceId }),
    });
    Context.run({ traceId: 't' }, () => {
      Context.setTenant({ id: 'org', kind: 'organization' });
      const carrier = Context.serialize();
      expect(carrier).toMatchObject({ tenantId: 'org', tenant: { kind: 'organization' } });
      Context.deserialize(carrier, () => {
        expect(Context.tenant()).toMatchObject({ id: 'org', kind: 'organization' });
      });
    });
  });

  it('an old carrier with only tenantId restores a legacy tenant', () => {
    Context.configure({ tenancy: { enabled: true } });
    Context.deserialize({ traceId: 't', tenantId: 'acme' }, () => {
      expect(Context.tenant()).toEqual({ id: 'acme', kind: 'unknown', source: 'legacy' });
    });
  });

  it('a carried tenant that disagrees with tenantId is dropped', () => {
    Context.deserialize(
      { traceId: 't', tenantId: 'a', tenant: { id: 'b', kind: 'organization', source: 'app' } },
      () => {
        expect(Context.tenant()).toEqual({ id: 'a', kind: 'unknown', source: 'legacy' });
      },
    );
  });

  it('the :scope snapshot restores the tenant (durable)', () => {
    const snapshot = Context.withTenant({ id: 'org', kind: 'organization' }, () =>
      structuredClone(contextAccessor.get()),
    ) as unknown as Record<string, unknown>;
    scope(snapshot, () => {
      expect(Context.tenant()).toMatchObject({ id: 'org', kind: 'organization' });
    });
  });
});

describe('baggage', () => {
  it('adds tenantKind next to tenantId when tenancy is on', () => {
    Context.configure({ tenancy: { enabled: true } });
    Context.withTenant({ id: 'org', kind: 'organization' }, () => {
      expect(Context.toBaggage()).toBe('tenantId=org,tenantKind=organization');
    });
  });

  it('ignores a tenant from incoming baggage when tenancy is on, unless trusted', () => {
    Context.configure({ tenancy: { enabled: true } });
    Context.fromBaggage('tenantId=org,tenantKind=organization', () => {
      expect(Context.tenant()).toBeUndefined();
    });
    Context.configure({ tenancy: { enabled: true, trustBaggage: true } });
    Context.fromBaggage('tenantId=org,tenantKind=organization', () => {
      expect(Context.tenant()).toEqual({ id: 'org', kind: 'organization', source: 'baggage' });
    });
  });

  it('keeps today behaviour while tenancy is off', () => {
    Context.fromBaggage('tenantId=org', () => {
      expect(Context.tenantId()).toBe('org');
    });
  });
});

describe('population', () => {
  it('the middleware syncs a tenant returned by initialize', async () => {
    setContextHttpOptions({
      initialize: () => ({ tenant: { id: 'c1', kind: 'clinic', source: 'app' } }),
    });
    let store: ContextStore | undefined;
    const ctx = { request: { headers: () => ({}), id: () => undefined } };
    await new ContextMiddleware().handle(ctx as never, async () => {
      store = Context.get();
    });
    expect(store?.tenantId).toBe('c1');
  });

  it('runWithContext accepts a tenant', () => {
    runWithContext({ tenant: { id: 'org', kind: 'organization', source: 'app' } }, () => {
      expect(Context.tenantId()).toBe('org');
    });
  });
});

describe('global slots', () => {
  it('publishes the tenancy slot, version 1', () => {
    const slot = (globalThis as Record<symbol, unknown>)[CONTEXT_TENANCY] as TenancySlot;
    expect(CONTEXT_TENANCY).toBe(Symbol.for('@agora/context:tenancy'));
    expect(slot.version).toBe(1);
    expect(Object.isFrozen(slot)).toBe(true);
    Context.configure({ tenancy: { enabled: true, kinds: ['organization'] } });
    expect(slot.tenancy()).toEqual({
      enabled: true,
      kinds: ['organization'],
      required: false,
      personal: false,
      trustBaggage: false,
    });
    slot.withTenant({ id: 'org', kind: 'organization' }, () => {
      expect(slot.tenantFilter()).toMatchObject({ mode: 'tenant', tenant: { id: 'org' } });
    });
  });

  it('the accessor slot exposes tenant(), tenancy() and tenantFilter()', () => {
    const accessor = (globalThis as Record<symbol, unknown>)[CONTEXT_ACCESSOR] as {
      tenant(): unknown;
      tenancy(): { enabled: boolean };
      tenantFilter(): { mode: string };
    };
    expect(accessor.tenancy().enabled).toBe(false);
    expect(accessor.tenantFilter()).toEqual({ mode: 'system' });
    Context.withTenant({ id: 'x', kind: 'organization' }, () => {
      expect(accessor.tenant()).toMatchObject({ id: 'x' });
    });
  });

  it('tenantLabels uses tenancy.label first, then a registered labeler, never throws', async () => {
    expect(await Context.tenantLabels(['a'])).toEqual({});
    Context.setTenantLabeler((ids) => Object.fromEntries(ids.map((id) => [id, `L-${id}`])));
    expect(await Context.tenantLabels(['a'])).toEqual({ a: 'L-a' });
    Context.configure({ tenancy: { label: () => ({ a: 'from config' }) } });
    // configure() replaces the config but keeps a registered labeler.
    expect(await Context.tenantLabels(['a'])).toEqual({ a: 'from config' });
    Context.configure({
      tenancy: {
        label: () => {
          throw new Error('boom');
        },
      },
    });
    expect(await Context.tenantLabels(['a'])).toEqual({});
  });
});

describe('ContextProvider', () => {
  function fakeApp(config: object) {
    return {
      config: { get: (key: string, fallback?: unknown) => (key === 'context' ? config : fallback) },
    } as unknown as ApplicationService;
  }

  it('says once at boot that the tenant is added to a carrier that omits it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await new ContextProvider(
      fakeApp({ carrier: ['traceId', 'userRef'], tenancy: { enabled: true } }),
    ).boot();
    expect(info).toHaveBeenCalledTimes(1);
    info.mockClear();
    Context.resetConfig();
    await new ContextProvider(fakeApp({ tenancy: { enabled: true } })).boot();
    expect(info).not.toHaveBeenCalled();
  });
});
