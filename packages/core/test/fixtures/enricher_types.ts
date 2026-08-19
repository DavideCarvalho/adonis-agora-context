/**
 * Type-level fixture for `ContextEnricher`, checked by `enricher_types.spec.ts`
 * with the real TypeScript compiler.
 *
 * The unit tests run through swc, which strips types without checking them, so
 * a plain `.spec.ts` cannot prove that these forms compile. This file is fed to
 * `ts.createProgram` instead, and the spec asserts it produces no diagnostics.
 */

import type { ContextEnricher } from '../../src/context.js';

declare module '../../src/context.js' {
  interface ContextStore {
    region?: string;
    locale?: string;
  }
}

/** Mutate-in-place: writes onto the store and returns nothing. */
export const mutating: ContextEnricher = (store) => {
  store.region = `region-${store.tenantId ?? 'none'}`;
};

/** Returns a partial that the runner merges into the store. */
export const patching: ContextEnricher = (store) => ({
  region: `region-${store.tenantId ?? 'none'}`,
});

/** Conditionally returns a patch — the `undefined` branch is legal too. */
export const conditional: ContextEnricher = (store) =>
  store.tenantId === undefined ? undefined : { region: store.tenantId };

/** The second argument is `unknown`, so it has to be narrowed before use. */
export const fromRequest: ContextEnricher = (store, req) => {
  const ctx = req as { request: { header(name: string): string | undefined } } | undefined;
  const locale = ctx?.request.header('accept-language');
  if (locale !== undefined) {
    store.locale = locale;
  }
};
