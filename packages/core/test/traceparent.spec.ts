import { describe, expect, it } from 'vitest';
import {
  extractTraceparent,
  parseTraceparent,
  randomTraceId,
  toTraceparent,
} from '../src/index.js';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

describe('extractTraceparent', () => {
  it('extracts the trace-id from a valid traceparent', () => {
    expect(extractTraceparent({ traceparent: VALID })).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('reads from a custom header name', () => {
    expect(extractTraceparent({ 'x-trace': VALID }, 'x-trace')).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
  });

  it('handles array header values', () => {
    expect(extractTraceparent({ traceparent: [VALID, 'other'] })).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
  });

  it('returns undefined when missing', () => {
    expect(extractTraceparent({})).toBeUndefined();
  });

  it('returns undefined for a malformed header', () => {
    expect(extractTraceparent({ traceparent: 'not-a-traceparent' })).toBeUndefined();
  });

  it('rejects an all-zero trace-id', () => {
    expect(
      extractTraceparent({
        traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      }),
    ).toBeUndefined();
  });
});

describe('randomTraceId', () => {
  it('produces a 32-hex-char id', () => {
    const id = randomTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces distinct ids', () => {
    expect(randomTraceId()).not.toBe(randomTraceId());
  });

  it('stays well-formed and unique across entropy-pool refills', () => {
    // Enough ids (mixed with span-ids, which share the pool) to cross several refills.
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = randomTraceId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      ids.add(id);
      expect(toTraceparent(id)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    }
    expect(ids.size).toBe(2000);
  });
});

describe('parseTraceparent', () => {
  it('returns the trace-id, parent-id, and flags of a valid header', () => {
    expect(parseTraceparent({ traceparent: VALID })).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      flags: '01',
    });
  });

  it('preserves a not-sampled (-00) flags byte', () => {
    const notSampled = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
    expect(parseTraceparent({ traceparent: notSampled })?.flags).toBe('00');
  });

  it('reads from a custom header name', () => {
    expect(parseTraceparent({ 'x-trace': VALID }, 'x-trace')?.parentId).toBe('00f067aa0ba902b7');
  });

  it('returns undefined when missing or malformed', () => {
    expect(parseTraceparent({})).toBeUndefined();
    expect(parseTraceparent({ traceparent: 'nope' })).toBeUndefined();
  });

  it('rejects an all-zero trace-id', () => {
    expect(
      parseTraceparent({
        traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      }),
    ).toBeUndefined();
  });
});

describe('toTraceparent', () => {
  it('round-trips a trace-id back out of a traceparent', () => {
    const id = randomTraceId();
    expect(extractTraceparent({ traceparent: toTraceparent(id) })).toBe(id);
  });

  it('generates a valid, sampled traceparent when there is no upstream', () => {
    const tp = toTraceparent(randomTraceId());
    expect(tp).toMatch(TRACEPARENT_RE);
    expect(tp.endsWith('-01')).toBe(true);
  });

  it('mints a fresh parent-id each call when there is no upstream', () => {
    const id = randomTraceId();
    expect(toTraceparent(id)).not.toBe(toTraceparent(id));
  });

  it('preserves the upstream parent span-id when given one', () => {
    const upstream = parseTraceparent({ traceparent: VALID });
    const tp = toTraceparent(upstream!.traceId, upstream);
    expect(tp).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('round-trips an upstream not-sampled (-00) traceparent as -00', () => {
    const notSampled = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';
    const upstream = parseTraceparent({ traceparent: notSampled });
    expect(toTraceparent(upstream!.traceId, upstream)).toBe(notSampled);
  });

  it('mints a fresh parent-id when the upstream carries none', () => {
    const id = randomTraceId();
    expect(toTraceparent(id, { traceId: id })).toMatch(TRACEPARENT_RE);
  });
});
