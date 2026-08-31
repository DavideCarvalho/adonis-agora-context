import { Context, type ContextStore, ensureTraceId, type UserRef } from './context.js';

/**
 * The patch a {@link ContextWriter} merges into the active store. The known
 * fields (`userRef`, `tenantId`) are typed; arbitrary keys are accepted too so a
 * sibling lib can populate fields it has module-augmented onto the
 * {@link ContextStore} without importing those types here.
 */
export interface ContextSetPatch {
  userRef?: UserRef;
  tenantId?: string;
  [k: string]: unknown;
}

/**
 * The structural WRITE counterpart of the read-only accessor: a tiny writer that
 * merges a patch into the CURRENTLY-ACTIVE context store. Intentionally narrow —
 * it populates, it does not drive the lifecycle (no `run`/`enterWith`).
 */
export interface ContextWriter {
  /**
   * Merge `patch` into the active store via {@link Context.set}. No-op (never
   * throws) when there is no active context — the value is simply dropped,
   * mirroring `Context.set`'s out-of-context behaviour.
   */
  set(patch: ContextSetPatch): void;
}

/** Default writer: a thin facade over the singleton {@link Context}. */
export const contextWriter: ContextWriter = {
  set(patch: ContextSetPatch): void {
    for (const key of Object.keys(patch)) {
      // Reuse Context.set so the active-store lookup + out-of-context no-op live
      // in one place. The cast bridges the open-ended patch to the keyed setter.
      Context.set(key as keyof ContextStore, patch[key] as ContextStore[keyof ContextStore]);
    }
  },
};

/**
 * The cross-copy-stable global slot the ecosystem POPULATES the context through.
 * Symmetric to {@link CONTEXT_ACCESSOR}: other Agora libs (e.g.
 * `@adonis-agora/authkit`) read `globalThis[Symbol.for('@agora/context:set')]`
 * STRUCTURALLY so they can write `userRef`/`tenantId` into the active context
 * without importing `@adonis-agora/context` — they degrade to `undefined` (no
 * write) when it is absent. Published here at module load so merely importing
 * `@adonis-agora/context` (which every app that installs it does, via the
 * provider) wires the contract.
 */
export const CONTEXT_SET = Symbol.for('@agora/context:set');
(globalThis as Record<symbol, unknown>)[CONTEXT_SET] = contextWriter.set;

/**
 * Run `fn` INSIDE a freshly-entered context store seeded from a full `snapshot`.
 * Unlike {@link CONTEXT_SET} — which only populates an ALREADY-ACTIVE store, a
 * no-op where none exists — this ESTABLISHES the store, so it is the primitive a
 * worker with no active scope needs to restore a context before running work.
 *
 * The ENTIRE `snapshot` is preserved (including module-augmented keys other libs
 * added to {@link ContextStore}); nothing is dropped — it is handed straight to
 * {@link Context.run}. When `snapshot` is absent, `fn` runs with no active store.
 */
export function contextScope<T>(snapshot: Record<string, unknown> | undefined, fn: () => T): T {
  if (snapshot === undefined) {
    return fn();
  }
  // Run with the full snapshot so every key survives the round-trip. The cast
  // bridges the open-ended snapshot to the ContextStore shape — a snapshot may
  // legitimately carry module-augmented fields this package does not know about.
  // A snapshot may arrive missing/empty `traceId` (e.g. a hand-built scope, or
  // one produced by a different runtime). Route it through `ensureTraceId` —
  // exactly as `deserialize`/`fromCarrier` do for incoming carriers — so the
  // `ContextStore.traceId: string` invariant is upheld and never silently
  // produces an invalid store.
  const store = ensureTraceId(snapshot as unknown as ContextStore);
  return Context.run(store, fn);
}

/**
 * The cross-copy-stable global slot the ecosystem RESTORES a context through.
 * Counterpart to {@link CONTEXT_SET}, but SCOPED: where `set` writes into an
 * active store, this one runs `fn` inside a store seeded from a snapshot — the
 * primitive `@adonis-agora/durable` needs on a worker that has no active scope.
 * Other Agora libs read `globalThis[Symbol.for('@agora/context:scope')]`
 * STRUCTURALLY (no import) and degrade to `undefined` when it is absent.
 * Published here at module load, mirroring {@link CONTEXT_SET}.
 */
export const CONTEXT_SCOPE = Symbol.for('@agora/context:scope');
(globalThis as Record<symbol, unknown>)[CONTEXT_SCOPE] = contextScope;
