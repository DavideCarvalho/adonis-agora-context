import type { UserRef } from './context.js';

/**
 * W3C Baggage codec + the context↔baggage field mapping.
 *
 * Baggage (https://www.w3.org/TR/baggage/) is a single comma-delimited header:
 *   `baggage: key1=value1,key2=value2;prop=x`
 * Values may be percent-encoded and may carry `;`-delimited properties we ignore.
 *
 * This is the standards-compliant, additional propagation option that rides a
 * real `baggage` header — complementary to the bespoke {@link ContextCarrier}
 * (which the app transports however it likes). Nothing here changes the carrier
 * path; baggage is opt-in via {@link Context.toBaggage}/{@link Context.fromBaggage}.
 */

/** A decoded baggage map: bare `key → value` pairs (properties stripped). */
export type Baggage = Record<string, string>;

/**
 * Encode a flat `key → value` map into a W3C `baggage` header value. Values are
 * percent-encoded so reserved characters (`,` `=` `;` whitespace) survive the
 * round-trip. Returns `''` when there is nothing to encode.
 */
export function encodeBaggage(entries: Baggage): string {
  const parts: string[] = [];
  for (const key of Object.keys(entries)) {
    const value = entries[key];
    if (value === undefined) {
      continue;
    }
    // Keys are passed through verbatim (callers control them); values are
    // percent-encoded per the baggage grammar.
    parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.join(',');
}

/**
 * Decode a W3C `baggage` header value into a flat `key → value` map. Tolerant by
 * design — malformed members are skipped rather than throwing:
 * - empty members / stray commas / surrounding whitespace are ignored,
 * - members without `=` or with an empty key are dropped,
 * - `;`-delimited properties after the value are stripped,
 * - a value that is not valid percent-encoding is kept raw.
 *
 * Accepts the raw header (or `undefined`/`string[]`, taking the first value).
 */
export function decodeBaggage(header: string | string[] | undefined): Baggage {
  const raw = Array.isArray(header) ? header[0] : header;
  const out: Baggage = {};
  if (!raw) {
    return out;
  }
  for (const member of raw.split(',')) {
    const trimmed = member.trim();
    if (trimmed === '') {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      // No `=`, or an empty key (`=value`): not a usable member.
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key === '') {
      continue;
    }
    // Drop any `;`-delimited baggage properties; we only carry the value.
    let value = trimmed.slice(eq + 1);
    const semi = value.indexOf(';');
    if (semi !== -1) {
      value = value.slice(0, semi);
    }
    value = value.trim();
    out[key] = safeDecode(value);
  }
  return out;
}

/** `decodeURIComponent` that never throws — returns the raw value on failure. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * How context fields map onto baggage keys. Defaults to the field names
 * (`tenantId`, `userRef`); override via `ContextModule.forRoot({ baggage })` to
 * use your own namespaced keys (e.g. `acme.tenant`). `false` disables a field.
 */
export interface BaggageKeyMap {
  /** Baggage key for `tenantId`, or `false` to never propagate it. */
  tenantId?: string | false;
  /** Baggage key for `userRef`, or `false` to never propagate it. */
  userRef?: string | false;
  /**
   * Baggage key for the tenant's `kind` (sent next to `tenantId` when tenancy is
   * enabled), or `false` to never propagate it.
   */
  tenantKind?: string | false;
}

/** The resolved baggage keys actually used by encode/decode. */
export interface ResolvedBaggageKeys {
  tenantId: string | false;
  userRef: string | false;
  tenantKind: string | false;
}

/** Apply defaults to a (possibly partial / undefined) {@link BaggageKeyMap}. */
export function resolveBaggageKeys(map: BaggageKeyMap | undefined): ResolvedBaggageKeys {
  return {
    tenantId: map?.tenantId ?? 'tenantId',
    userRef: map?.userRef ?? 'userRef',
    tenantKind: map?.tenantKind ?? 'tenantKind',
  };
}

/**
 * Encode a {@link UserRef} as a compact baggage value: `type:id`. The first
 * colon separates type from id; ids may themselves contain colons.
 */
export function encodeUserRef(ref: UserRef): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * Parse a `type:id` baggage value back into a {@link UserRef}. A token with no
 * colon is tolerated: it is treated as the id with a default `type` of `'user'`.
 * Returns `undefined` only for an empty token.
 */
export function decodeUserRef(token: string): UserRef | undefined {
  if (token === '') {
    return undefined;
  }
  const colon = token.indexOf(':');
  if (colon === -1) {
    return { type: 'user', id: token };
  }
  return { type: token.slice(0, colon), id: token.slice(colon + 1) };
}
