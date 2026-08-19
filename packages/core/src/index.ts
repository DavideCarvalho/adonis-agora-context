/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.6.0';

export { Context } from './context.js';
export type {
  ContextStore,
  ContextCarrier,
  ContextEnricher,
  UserRef,
} from './context.js';
export {
  type Baggage,
  type BaggageKeyMap,
  decodeBaggage,
  decodeUserRef,
  encodeBaggage,
  encodeUserRef,
} from './baggage.js';
export { CONTEXT_ACCESSOR, contextAccessor } from './accessor.js';
export type { ContextAccessor } from './accessor.js';
export { CONTEXT_SCOPE, CONTEXT_SET, contextScope, contextWriter } from './writer.js';
export type { ContextWriter, ContextSetPatch } from './writer.js';
export { defineConfig } from './define_config.js';
export type { ContextConfig } from './define_config.js';
export {
  extractTraceparent,
  parseTraceparent,
  randomTraceId,
  toTraceparent,
} from './traceparent.js';
export type { ParsedTraceparent } from './traceparent.js';

// Re-export the configure hook from the package root so `node ace configure` finds it
export { configure } from '../configure.js';
