import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context, type ContextCarrier, type ContextStore } from '../src/index.js';

// Augment the store with a derived field the lazy tests memoize onto it.
declare module '../src/index.js' {
  interface ContextStore {
    displayName?: string;
  }
}

describe('Context', () => {
  it('returns undefined when read outside any context', () => {
    expect(Context.get()).toBeUndefined();
    expect(Context.traceId()).toBeUndefined();
    expect(Context.tenantId()).toBeUndefined();
    expect(Context.userRef()).toBeUndefined();
    expect(Context.serialize()).toBeUndefined();
  });

  it('set is a no-op outside any context (does not throw)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => Context.set('tenantId', 't1')).not.toThrow();
    expect(Context.tenantId()).toBeUndefined();
    warn.mockRestore();
  });

  it('set outside any context warns (visible footgun) but stays a no-op', () => {
    Context.resetSetWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Context.set('userRef', { type: 'user', id: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[@adonis-agora/context]');
    expect(warn.mock.calls[0]?.[0]).toContain('userRef');
    // one-shot: a second out-of-context set does not spam
    Context.set('tenantId', 't1');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('set inside a context does not warn', () => {
    Context.resetSetWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Context.run({ traceId: 'x' }, () => {
      Context.set('tenantId', 't1');
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('run exposes the active store and unwinds after', () => {
    const store: ContextStore = { traceId: 'abc' };
    Context.run(store, () => {
      expect(Context.get()).toBe(store);
      expect(Context.traceId()).toBe('abc');
    });
    expect(Context.get()).toBeUndefined();
  });

  it('enterWith establishes a context without a callback scope', async () => {
    await Context.run({ traceId: 'outer' }, async () => {
      Context.enterWith({ traceId: 'entered' });
      // survives the await within the same async branch
      await Promise.resolve();
      expect(Context.traceId()).toBe('entered');
    });
  });

  it('set after enterWith mutates the active store', () => {
    Context.run({ traceId: 'x' }, () => {
      Context.enterWith({ traceId: 'x' });
      Context.set('userRef', { type: 'user', id: 7 });
      Context.set('tenantId', 'tenant-1');
      expect(Context.userRef()).toEqual({ type: 'user', id: 7 });
      expect(Context.tenantId()).toBe('tenant-1');
    });
  });

  it('isolates two concurrent contexts (run)', async () => {
    const seen: Array<string | undefined> = [];
    await Promise.all([
      Context.run({ traceId: 'a', tenantId: 'ta' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(Context.tenantId());
      }),
      Context.run({ traceId: 'b', tenantId: 'tb' }, async () => {
        seen.push(Context.tenantId());
      }),
    ]);
    expect(seen.sort()).toEqual(['ta', 'tb']);
  });

  it('isolates two concurrent contexts (enterWith inside run)', async () => {
    const results = await Promise.all([
      Context.run({ traceId: 'r1' }, async () => {
        Context.enterWith({ traceId: 't1' });
        await new Promise((r) => setTimeout(r, 5));
        return Context.traceId();
      }),
      Context.run({ traceId: 'r2' }, async () => {
        Context.enterWith({ traceId: 't2' });
        return Context.traceId();
      }),
    ]);
    expect(results.sort()).toEqual(['t1', 't2']);
  });
});

describe('Context serialize/deserialize', () => {
  it('serialize produces a plain carrier of trace/tenant/userRef only', () => {
    Context.run(
      { traceId: 'tid', requestId: 'rid', tenantId: 'ten', userRef: { type: 'user', id: 1 } },
      () => {
        const carrier = Context.serialize();
        expect(carrier).toEqual({
          traceId: 'tid',
          tenantId: 'ten',
          userRef: { type: 'user', id: 1 },
        });
        // requestId is intentionally NOT carried across the boundary
        expect(carrier && 'requestId' in carrier).toBe(false);
      },
    );
  });

  it('round-trips userRef/tenant/traceId through deserialize', () => {
    let carrier: ReturnType<typeof Context.serialize>;
    Context.run(
      { traceId: 'T', tenantId: 'tenant-9', userRef: { type: 'admin', id: 'abc' } },
      () => {
        carrier = Context.serialize();
      },
    );

    expect(carrier).toBeDefined();
    Context.deserialize(carrier!, () => {
      expect(Context.traceId()).toBe('T');
      expect(Context.tenantId()).toBe('tenant-9');
      expect(Context.userRef()).toEqual({ type: 'admin', id: 'abc' });
    });
  });

  it('deserialize of a trace-only carrier leaves tenant/userRef undefined', () => {
    Context.deserialize({ traceId: 'only' }, () => {
      expect(Context.traceId()).toBe('only');
      expect(Context.tenantId()).toBeUndefined();
      expect(Context.userRef()).toBeUndefined();
    });
  });

  it('deserialize of an absent carrier runs fn with no active store (no throw)', () => {
    // A job that arrives without a carrier (external producer, older job) must
    // still run — fn executes with no active context rather than throwing.
    let ran = false;
    const result = Context.deserialize(undefined, () => {
      ran = true;
      expect(Context.get()).toBeUndefined();
      expect(Context.traceId()).toBeUndefined();
      return 'ok';
    });
    expect(ran).toBe(true);
    expect(result).toBe('ok');
  });
});

describe('Context.bind', () => {
  it('re-enters the captured context when the bound fn runs later outside it', async () => {
    let bound: (() => ContextStore | undefined) | undefined;
    Context.run({ traceId: 'snap', tenantId: 'tn' }, () => {
      bound = Context.bind(() => Context.get());
    });
    // Outside any context now.
    expect(Context.get()).toBeUndefined();
    const seen = await new Promise<ContextStore | undefined>((resolve) => {
      setTimeout(() => resolve(bound!()), 0);
    });
    expect(seen?.traceId).toBe('snap');
    expect(seen?.tenantId).toBe('tn');
  });

  it('forwards arguments and the return value', () => {
    const bound = Context.run({ traceId: 'x' }, () =>
      Context.bind((a: number, b: number) => a + b + (Context.traceId() === 'x' ? 0 : 100)),
    );
    expect(bound(2, 3)).toBe(5);
  });

  it('preserves `this` when invoked as a method', () => {
    const obj = {
      val: 42,
      run: Context.run({ traceId: 'x' }, () =>
        Context.bind(function (this: { val: number }) {
          return this.val;
        }),
      ),
    };
    expect(obj.run()).toBe(42);
  });

  it('captures no context when bound outside one (runs with no active store)', () => {
    const bound = Context.bind(() => Context.get());
    expect(bound()).toBeUndefined();
  });

  it('binds the snapshot at bind time, independent of later context', () => {
    const bound = Context.run({ traceId: 'first' }, () => Context.bind(() => Context.traceId()));
    const seen = Context.run({ traceId: 'second' }, () => bound());
    expect(seen).toBe('first');
  });
});

describe('Context.lazy (computed on first access, memoized per store)', () => {
  it('computes once and caches on the active store', () => {
    const factory = vi.fn((store: ContextStore) => `name-${store.tenantId}`);
    Context.run({ traceId: 'x', tenantId: 'acme' }, () => {
      const a = Context.lazy('displayName', factory);
      const b = Context.lazy('displayName', factory);
      expect(a).toBe('name-acme');
      expect(b).toBe('name-acme');
      // Memoized: factory ran exactly once.
      expect(factory).toHaveBeenCalledTimes(1);
      // Cached onto the store field.
      expect(Context.get()?.displayName).toBe('name-acme');
    });
  });

  it('recomputes in a different context (cache is per store)', () => {
    const factory = (store: ContextStore) => `name-${store.tenantId}`;
    const first = Context.run({ traceId: 'x', tenantId: 'a' }, () =>
      Context.lazy('displayName', factory),
    );
    const second = Context.run({ traceId: 'y', tenantId: 'b' }, () =>
      Context.lazy('displayName', factory),
    );
    expect(first).toBe('name-a');
    expect(second).toBe('name-b');
  });

  it('returns undefined outside any context (no store to cache on)', () => {
    expect(Context.lazy('displayName', () => 'x')).toBeUndefined();
  });

  it('an already-present field short-circuits the factory', () => {
    const factory = vi.fn(() => 'computed');
    Context.run({ traceId: 'x', displayName: 'preset' }, () => {
      expect(Context.lazy('displayName', factory)).toBe('preset');
      expect(factory).not.toHaveBeenCalled();
    });
  });
});

describe('P9 — deserialize guards a missing traceId from the carrier', () => {
  afterEach(() => {
    Context.resetConfig();
  });

  it('generates a traceId when the carrier omits it (default deserialize)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A cross-process carrier with no traceId (e.g. produced elsewhere).
    const carrier = { tenantId: 'ten' } as unknown as ContextCarrier;
    Context.deserialize(carrier, () => {
      expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
      expect(Context.tenantId()).toBe('ten');
    });
    warn.mockRestore();
  });

  it('generates a traceId when an empty-string traceId arrives', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Context.deserialize({ traceId: '' }, () => {
      expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
    });
    warn.mockRestore();
  });

  it('guards a custom deserialize override that returns a falsy traceId', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Context.configure({
      // Pathological override: drops the traceId entirely.
      deserialize: (c: ContextCarrier): ContextStore => ({
        traceId: undefined as unknown as string,
        tenantId: c.tenantId,
      }),
    });
    Context.deserialize({ traceId: 'incoming', tenantId: 'tn' }, () => {
      // invariant preserved despite the bad override
      expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
      expect(Context.tenantId()).toBe('tn');
    });
    warn.mockRestore();
  });
});

describe('Context.runEnrichers (the non-HTTP flow: run/enterWith, then enrich)', () => {
  afterEach(() => {
    Context.resetConfig();
  });

  it('applies an enricher that only mutates the store in place', () => {
    Context.configure({
      enrichers: [
        (store) => {
          store.displayName = `tenant-${store.tenantId}`;
        },
      ],
    });

    Context.run({ traceId: 'x', tenantId: 'acme' }, () => {
      Context.runEnrichers();
      expect(Context.get()?.displayName).toBe('tenant-acme');
    });
  });

  it('merges the partial a returning enricher hands back', () => {
    Context.configure({
      enrichers: [(store) => ({ displayName: `tenant-${store.tenantId}` })],
    });

    Context.run({ traceId: 'x', tenantId: 'acme' }, () => {
      Context.runEnrichers();
      expect(Context.get()?.displayName).toBe('tenant-acme');
    });
  });

  it('runs mutating and returning enrichers side by side, in order', () => {
    Context.configure({
      enrichers: [
        (store) => {
          store.tenantId = 'from-mutation';
        },
        (store) => ({ displayName: `tenant-${store.tenantId}` }),
      ],
    });

    Context.run({ traceId: 'x' }, () => {
      Context.runEnrichers();
      expect(Context.get()?.tenantId).toBe('from-mutation');
      // The second enricher saw the field the first one mutated in place.
      expect(Context.get()?.displayName).toBe('tenant-from-mutation');
    });
  });

  it('forwards the caller-supplied request object as the second argument', () => {
    const seen: unknown[] = [];
    Context.configure({
      enrichers: [
        (store, req) => {
          seen.push(req);
          store.displayName = (req as { tenant: string }).tenant;
        },
      ],
    });

    Context.run({ traceId: 'x' }, () => {
      Context.runEnrichers({ tenant: 'acme' });
      expect(seen).toEqual([{ tenant: 'acme' }]);
      expect(Context.get()?.displayName).toBe('acme');
    });
  });

  it('isolates a throwing enricher from the ones after it', () => {
    Context.configure({
      enrichers: [
        () => {
          throw new Error('boom');
        },
        (store) => {
          store.displayName = 'still-ran';
        },
      ],
    });

    Context.run({ traceId: 'x' }, () => {
      expect(() => Context.runEnrichers()).not.toThrow();
      expect(Context.get()?.displayName).toBe('still-ran');
    });
  });

  it('is a no-op outside any context, and with no enrichers configured', () => {
    const enricher = vi.fn(() => ({ displayName: 'never' }));
    Context.configure({ enrichers: [enricher] });
    expect(() => Context.runEnrichers()).not.toThrow();
    expect(enricher).not.toHaveBeenCalled();

    Context.resetConfig();
    Context.run({ traceId: 'x' }, () => {
      expect(() => Context.runEnrichers()).not.toThrow();
      expect(Context.get()?.displayName).toBeUndefined();
    });
  });
});
