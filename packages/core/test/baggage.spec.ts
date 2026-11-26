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
  it('hydrates tenantId + userRef from a baggage header and runs fn inside', () => {
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

describe('Context.fromBaggage identity trust (security)', () => {
  const forged = encodeBaggage({ tenantId: 'victim', userRef: 'admin:root' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops tenantId and userRef from an unverified header by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Context.fromBaggage(forged, () => {
      expect(Context.tenantId()).toBeUndefined();
      expect(Context.userRef()).toBeUndefined();
      expect(Context.traceId()).toMatch(/^[0-9a-f]{32}$/);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // One-shot: a second drop does not warn again.
    Context.fromBaggage(forged, () => {});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn in production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      Context.fromBaggage(forged, () => {
        expect(Context.tenantId()).toBeUndefined();
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts the claim when the verifier returns true, and shows it the claim', () => {
    const seen: unknown[] = [];
    Context.fromBaggage(
      forged,
      () => {
        expect(Context.tenantId()).toBe('victim');
        expect(Context.userRef()).toEqual({ type: 'admin', id: 'root' });
      },
      {
        trust: (identity, baggage) => {
          seen.push(identity, baggage.tenantId);
          return true;
        },
      },
    );
    expect(seen).toEqual([
      { tenantId: 'victim', userRef: { type: 'admin', id: 'root' } },
      'victim',
    ]);
  });

  it('drops the claim when the verifier returns false', () => {
    Context.fromBaggage(
      forged,
      () => {
        expect(Context.tenantId()).toBeUndefined();
        expect(Context.userRef()).toBeUndefined();
      },
      { trust: () => false },
    );
  });

  it('uses the identity the verifier returns instead of the claim', () => {
    Context.fromBaggage(
      forged,
      () => {
        expect(Context.tenantId()).toBe('real');
        expect(Context.userRef()).toBeUndefined();
      },
      { trust: () => ({ tenantId: 'real' }) },
    );
  });

  it('fails closed when the verifier throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let ran = false;
    Context.fromBaggage(
      forged,
      () => {
        ran = true;
        expect(Context.tenantId()).toBeUndefined();
        expect(Context.userRef()).toBeUndefined();
      },
      {
        trust: () => {
          throw new Error('bad token');
        },
      },
    );
    expect(ran).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses an async verifier in the sync fromBaggage without running fn', () => {
    let ran = false;
    expect(() =>
      Context.fromBaggage(
        forged,
        () => {
          ran = true;
        },
        // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong type
        { trust: (async () => true) as any },
      ),
    ).toThrow(/fromBaggageVerified/);
    expect(ran).toBe(false);
  });

  it('fromBaggageVerified awaits an async verifier', async () => {
    const result = await Context.fromBaggageVerified(forged, () => Context.tenantId(), {
      trust: async () => true,
    });
    expect(result).toBe('victim');
  });

  it('fromBaggageVerified fails closed when the verifier rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await Context.fromBaggageVerified(
      forged,
      () => [Context.tenantId(), Context.userRef()],
      {
        trust: async () => {
          throw new Error('nope');
        },
      },
    );
    expect(result).toEqual([undefined, undefined]);
  });

  it('fromBaggageVerified drops identity without a verifier', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await Context.fromBaggageVerified(forged, () => Context.tenantId());
    expect(result).toBeUndefined();
  });
});
