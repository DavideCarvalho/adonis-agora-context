---
'@adonis-agora/context': major
---

**Security (behavior change):** `Context.fromBaggage()` no longer trusts identity from the incoming `baggage` header by default.

A `baggage` header is unauthenticated: any client could send `tenantId=…,userRef=…` and pick the tenant (and with it the tenant database connection used by `tenantConnection`) and the user for the code running inside. Now `tenantId`, `tenantKind` and `userRef` are dropped unless the call opts in:

- `trust: (claimed, baggage) => boolean | BaggageIdentity` — verify the claim (e.g. against a signed service token); return `true` to accept it, `false` to drop it, or your own verified `{ tenantId, userRef }`.
- `trustIdentity: true` — accept it as-is, only on hops you control end to end.

For a verifier that needs to await, use the new `Context.fromBaggageVerified(header, fn, { trust: async … })`, which returns a Promise. An async `trust` passed to the sync `fromBaggage` is a type error and throws a `TypeError` at runtime instead of being read as "yes". On both paths a verifier that throws or rejects fails closed: identity is dropped, `fn` still runs with the trace id, and the error is reported with `console.warn` (once per process in production).

`tenancy.trustBaggage: true` keeps accepting the tenant (never the user) app-wide, now also with tenancy off. Outside production, a one-time `console.warn` reports dropped identity and how to opt in. New exported types: `FromBaggageOptions`, `FromBaggageVerifiedOptions`, `BaggageIdentity`, `BaggageVerdict`, `BaggageVerifier`.

Migration: where you relied on `fromBaggage` restoring the tenant or user, add `{ trust }` (recommended) or `{ trustIdentity: true }` to that call.
