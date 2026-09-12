/**
 * Mirrors this package's `version` in package.json — not maintained by hand:
 * `pnpm version-packages` rewrites this literal via `scripts/sync-version.mjs`
 * after `changeset version` bumps the manifest, and `pnpm release` re-runs that
 * script with `--check` and refuses to publish while the two disagree.
 */
export const VERSION = '0.6.1';

// Re-export the configure hook from the package root so `node ace configure` finds it
export { configure } from '../configure.js';
export type { ContextAccessor } from './accessor.js';
export { CONTEXT_ACCESSOR, contextAccessor } from './accessor.js';
export {
  type Baggage,
  type BaggageKeyMap,
  decodeBaggage,
  decodeUserRef,
  encodeBaggage,
  encodeUserRef,
} from './baggage.js';
export type {
  ContextCarrier,
  ContextEnricher,
  ContextStore,
  UserRef,
} from './context.js';
export { Context } from './context.js';
export type { ContextConfig } from './define_config.js';
export { defineConfig } from './define_config.js';
export type { ParsedTraceparent } from './traceparent.js';
export {
  extractTraceparent,
  parseTraceparent,
  randomTraceId,
  toTraceparent,
} from './traceparent.js';
export type { ContextSetPatch, ContextWriter } from './writer.js';
export { CONTEXT_SCOPE, CONTEXT_SET, contextScope, contextWriter } from './writer.js';
