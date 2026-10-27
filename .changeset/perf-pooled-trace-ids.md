---
"@adonis-agora/context": patch
---

perf: generate trace-ids and span-ids from a pooled CSPRNG buffer (refilled every 4 KiB) instead of one `randomFillSync` call per id. Minting the trace-id the middleware assigns to every request without an upstream `traceparent` drops from ~1.5µs to ~80ns; ids keep the same format and are still fresh, never-reused random bytes.
