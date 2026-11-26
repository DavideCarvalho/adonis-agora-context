import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context, type ContextStore, decodeBaggage, encodeBaggage } from '../src/index.js';

afterEach(() => {
  Context.resetConfig();
});

describe('encodeBaggage / decodeBaggage (W3C baggage codec)', () => {
  it('round-trips simple key/value pairs', () => {
    const header = encodeBaggage({ tenantId: 'acme', region: 'eu' });
    // Order is insertion order; both pairs present.
    expect(decodeBaggage(header)).toEqual({ tenantId: 'acme', region: 'eu' });
  });

  it('percent-encodes values with reserved characters and decodes them back', () => {
    const header = encodeBaggage({ note: 'a,b=c d' });
    // The raw header must not contain bare reserved chars in the value.
    expect(header).not.toContain('a,b=c d');
    expect(decodeBaggage(header)).toEqual({ note: 'a,b=c d' });
  });

  it('returns an empty string when there is nothing to encode', () => {
    expect(encodeBaggage({})).toBe('');
  });

  it('tolerates a malformed baggage header (no equals sign)', () => {
    expect(decodeBaggage('garbage-without-equals')).toEqual({});
  });

  it('tolerates empty members, trailing commas, and stray whitespace', () => {
    expect(decodeBaggage('  tenantId = acme ,, ,region=eu, ')).toEqual({
      tenantId: 'acme',
      region: 'eu',
    });
  });

  it('ignores members with an empty key', () => {
    expect(decodeBaggage('=novalue,ok=1')).toEqual({ ok: '1' });
  });

  it('strips OTel baggage property suffixes (key=value;metadata)', () => {
    // W3C allows `;`-delimited properties after the value; we keep just the value.
    expect(decodeBaggage('tenantId=acme;ttl=30')).toEqual({ tenantId: 'acme' });
  });

  it('tolerates a value that is not valid percent-encoding (keeps it raw)', () => {
    expect(decodeBaggage('k=%zz')).toEqual({ k: '%zz' });
  });

  it('decodes an empty/undefined header to an empty object', () => {
    expect(decodeBaggage('')).toEqual({});
    expect(decodeBaggage(undefined)).toEqual({});
  });
});

describe('Context.toBaggage', () => {
  it('returns undefined outside any context', () => {
    expect(Context.toBaggage()).toBeUndefined();
  });

  it('maps tenantId + userRef to a W3C baggage header value', () => {
    Context.run({ traceId: 't', tenantId: 'acme', userRef: { type: 'user', id: 42 } }, () => {
      const header = Context.toBaggage();
      expect(header).toBeDefined();
      const decoded = decodeBaggage(header);
      expect(decoded.tenantId).toBe('acme');
      // userRef is encoded as a compact `type:id` token by default.
      expect(decoded.userRef).toBe('user:42');
    });
  });

  it('omits fields that are absent on the store', () => {
    Context.run({ traceId: 't', tenantId: 'acme' }, () => {
      const decoded = decodeBaggage(Context.toBaggage());
      expect(decoded.tenantId).toBe('acme');
      expect('userRef' in decoded).toBe(false);
    });
  });

  it('returns undefined when no mappable field is present', () => {
    Context.run({ traceId: 't' }, () => {
      expect(Context.toBaggage()).toBeUndefined();
    });
  });
});

describe('Context.fromBaggage', () => {
  it('hydrates tenantId + userRef with trustIdentity and runs fn inside', () => {
    const header = encodeBaggage({ tenantId: 'acme', userRef: 'admin:abc' });
    Context.fromBaggage(
      header,
      () => {
        expect(Context.tenantId()).toBe('acme');
        expect(Context.userRef()).toEqual({ type: 'admin', id: 'abc' });
        // traceId invariant always preserved.
        expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
      },
      { trustIdentity: true },
    );
  });

  it('round-trips tenant + userRef through a baggage header', () => {
    let header: string | undefined;
    Context.run(
      { traceId: 'T', tenantId: 'tenant-9', userRef: { type: 'admin', id: 'abc' } },
      () => {
        header = Context.toBaggage();
      },
    );
    Context.fromBaggage(
      header,
      () => {
        expect(Context.tenantId()).toBe('tenant-9');
        expect(Context.userRef()).toEqual({ type: 'admin', id: 'abc' });
      },
      { trustIdentity: true },
    );
  });

  it('tolerates a malformed baggage header (still runs, leaves fields undefined)', () => {
    Context.fromBaggage('this is not baggage', () => {
      expect(Context.tenantId()).toBeUndefined();
      expect(Context.userRef()).toBeUndefined();
      expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it('seeds traceId from a traceparent header when one is supplied', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    Context.fromBaggage(
      encodeBaggage({ tenantId: 'acme' }),
      () => {
        expect(Context.traceId()).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(Context.tenantId()).toBe('acme');
      },
      { traceparent: tp, trustIdentity: true },
    );
  });

  it('honours a custom baggage key map (configure)', () => {
    Context.configure({
      baggage: { tenantId: 'acme.tenant', userRef: 'acme.user' },
    });
    let header: string | undefined;
    Context.run({ traceId: 'x', tenantId: 'T', userRef: { type: 'user', id: 1 } }, () => {
      header = Context.toBaggage();
    });
    const decoded = decodeBaggage(header);
    expect(decoded['acme.tenant']).toBe('T');
    expect(decoded['acme.user']).toBe('user:1');

    Context.fromBaggage(
      header,
      () => {
        expect(Context.tenantId()).toBe('T');
        // Baggage is a text format: a numeric id serializes and re-hydrates as a
        // string. This is the documented round-trip behaviour.
        expect(Context.userRef()).toEqual({ type: 'user', id: '1' });
      },
      { trustIdentity: true },
    );
  });

  it('a userRef token with no colon is tolerated (treated as id, type "user")', () => {
    Context.fromBaggage(
      encodeBaggage({ userRef: 'bare-id' }),
      () => {
        expect(Context.userRef()).toEqual({ type: 'user', id: 'bare-id' });
      },
      { trustIdentity: true },
    );
  });

  it('does not require any baggage at all (empty header is fine)', () => {
    Context.fromBaggage(undefined, () => {
      expect(Context.tenantId()).toBeUndefined();
      expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it('the bespoke ContextCarrier serialize path is unchanged by baggage support', () => {
    Context.run({ traceId: 'tid', tenantId: 'ten', userRef: { type: 'user', id: 1 } }, () => {
      // Default carrier still trace/tenant/userRef only — no baggage leakage.
      expect(Context.serialize()).toEqual({
        traceId: 'tid',
        tenantId: 'ten',
        userRef: { type: 'user', id: 1 },
      } satisfies Partial<ContextStore>);
    });
  });
});

describe('Context.fromBaggage — identity trust', () => {
  const forged = encodeBaggage({ tenantId: 'victim', userRef: 'user:1', region: 'eu' });

  it('drops tenantId and userRef by default (baggage is unauthenticated)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      Context.fromBaggage(
        forged,
        () => {
          expect(Context.tenantId()).toBeUndefined();
          expect(Context.userRef()).toBeUndefined();
          // Non-identity seeding still works.
          expect(Context.traceId()).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        },
        { traceparent: tp },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once, naming both opt-ins, when identity is dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      Context.fromBaggage(forged, () => {});
      Context.fromBaggage(forged, () => {});
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('tenantId and userRef');
      expect(message).toContain('trust');
      expect(message).toContain('trustIdentity: true');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn in production, nor when nothing identity-like was sent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    try {
      Context.fromBaggage(encodeBaggage({ region: 'eu' }), () => {});
      process.env.NODE_ENV = 'production';
      Context.fromBaggage(forged, () => {});
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
      warn.mockRestore();
    }
  });

  it('trust: true accepts the claimed identity; the verifier sees it and the raw map', () => {
    const trust = vi.fn(() => true);
    Context.fromBaggage(
      forged,
      () => {
        expect(Context.tenantId()).toBe('victim');
        expect(Context.userRef()).toEqual({ type: 'user', id: '1' });
      },
      { trust },
    );
    expect(trust).toHaveBeenCalledWith(
      { tenantId: 'victim', userRef: { type: 'user', id: '1' } },
      { tenantId: 'victim', userRef: 'user:1', region: 'eu' },
    );
  });

  it('trust returning false/undefined drops the identity without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const verdict of [false, undefined, null]) {
        Context.fromBaggage(
          forged,
          () => {
            expect(Context.tenantId()).toBeUndefined();
            expect(Context.userRef()).toBeUndefined();
          },
          { trust: () => verdict },
        );
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('trust returning an identity uses the verified values, not the header', () => {
    Context.fromBaggage(
      forged,
      () => {
        expect(Context.tenantId()).toBe('real-tenant');
        expect(Context.userRef()).toEqual({ type: 'service', id: 'billing' });
      },
      { trust: () => ({ tenantId: 'real-tenant', userRef: { type: 'service', id: 'billing' } }) },
    );
  });

  it('a sync verifier that throws fails closed: fn runs without identity, error reported', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boom = new Error('bad signature');
      const result = Context.fromBaggage(
        forged,
        () => {
          expect(Context.tenantId()).toBeUndefined();
          expect(Context.userRef()).toBeUndefined();
          expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
          return 'ran';
        },
        {
          trust: () => {
            throw boom;
          },
        },
      );
      expect(result).toBe('ran');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe(boom);
    } finally {
      warn.mockRestore();
    }
  });

  it('a sync fromBaggage given an async verifier throws, pointing to fromBaggageVerified', () => {
    const fn = vi.fn();
    expect(() =>
      Context.fromBaggage(forged, fn, {
        // @ts-expect-error an async verifier is rejected by the sync API's types too
        trust: async () => true,
      }),
    ).toThrow(/fromBaggageVerified/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('tenancy.trustBaggage lets the tenant through app-wide but never the user', () => {
    Context.configure({ tenancy: { trustBaggage: true } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      Context.fromBaggage(forged, () => {
        expect(Context.tenantId()).toBe('victim');
        expect(Context.userRef()).toBeUndefined();
      });
      expect(String(warn.mock.calls[0]?.[0])).toContain('ignored userRef');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Context.fromBaggageVerified (async verifier)', () => {
  const forged = encodeBaggage({ tenantId: 'victim', userRef: 'user:1' });
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('async true accepts the claimed identity and resolves with fn result', async () => {
    const result = await Context.fromBaggageVerified(
      forged,
      async () => {
        await Promise.resolve();
        expect(Context.tenantId()).toBe('victim');
        expect(Context.userRef()).toEqual({ type: 'user', id: '1' });
        return 42;
      },
      { trust: async () => true },
    );
    expect(result).toBe(42);
  });

  it('async false drops the identity without warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await Context.fromBaggageVerified(
        forged,
        () => {
          expect(Context.tenantId()).toBeUndefined();
          expect(Context.userRef()).toBeUndefined();
        },
        { trust: async () => false },
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('async identity object replaces the claimed values', async () => {
    await Context.fromBaggageVerified(
      forged,
      () => {
        expect(Context.tenantId()).toBe('real-tenant');
        expect(Context.userRef()).toEqual({ type: 'service', id: 'billing' });
      },
      {
        trust: async (claimed, baggage) => {
          expect(claimed.tenantId).toBe('victim');
          expect(baggage.tenantId).toBe('victim');
          return { tenantId: 'real-tenant', userRef: { type: 'service', id: 'billing' } };
        },
      },
    );
  });

  it('a rejected verifier fails closed: identity dropped, trace kept, error reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boom = new Error('key fetch failed');
      const result = await Context.fromBaggageVerified(
        forged,
        () => {
          expect(Context.tenantId()).toBeUndefined();
          expect(Context.userRef()).toBeUndefined();
          expect(Context.traceId()).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
          return 'ran';
        },
        { traceparent: tp, trust: () => Promise.reject(boom) },
      );
      expect(result).toBe('ran');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe(boom);
    } finally {
      warn.mockRestore();
    }
  });

  it('a verifier that throws synchronously also fails closed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await Context.fromBaggageVerified(
        forged,
        () => {
          expect(Context.tenantId()).toBeUndefined();
        },
        {
          trust: () => {
            throw new Error('boom');
          },
        },
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports verifier errors only once per process in production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const trust = () => Promise.reject(new Error('down'));
      await Context.fromBaggageVerified(forged, () => {}, { trust });
      await Context.fromBaggageVerified(forged, () => {}, { trust });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = previous;
      warn.mockRestore();
    }
  });

  it('errors thrown by fn reject the returned promise', async () => {
    await expect(
      Context.fromBaggageVerified(
        forged,
        () => {
          throw new Error('work failed');
        },
        { trust: async () => true },
      ),
    ).rejects.toThrow('work failed');
  });

  it('without trust it behaves like fromBaggage (identity dropped), trustIdentity accepts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await Context.fromBaggageVerified(forged, () => {
        expect(Context.tenantId()).toBeUndefined();
      });
      await Context.fromBaggageVerified(
        forged,
        () => {
          expect(Context.tenantId()).toBe('victim');
        },
        { trustIdentity: true },
      );
    } finally {
      warn.mockRestore();
    }
  });
});
