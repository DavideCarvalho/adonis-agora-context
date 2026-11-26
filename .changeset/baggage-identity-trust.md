---
"@adonis-agora/context": minor
---

**Security (breaking):** `Context.fromBaggage()` no longer trusts identity from an incoming W3C `baggage` header by default. That header is unauthenticated, so `tenantId` and `userRef` found in it are now dropped unless the call opts in:

- `trust: (claimed, baggage) => boolean | { tenantId?, userRef? }` verifies the claim (for example against a signed service token) and can return the verified identity to use instead.
- `trustIdentity: true` accepts the header as-is. Use it only on hops you control end to end.

`Context.fromBaggageVerified(header, fn, { trust })` supports async verifiers. A verifier that throws or rejects fails closed (no tenant or user). A one-time development warning reports dropped identity. Calls that relied on the old behaviour must add `trust` or `trustIdentity: true`.
