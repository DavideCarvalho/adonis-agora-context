---
'@adonis-agora/context': minor
---

`ContextEnricher` now accepts an enricher that mutates the store in place

The type declared a `Partial<ContextStore> | undefined` return, so the
mutate-in-place style the JSDoc, the published `config/context.ts` stub and the
docs all described did not actually compile — `(store) => { store.tenantId = 'x' }`
failed with TS2322. The return type is widened to `Partial<ContextStore> | void`,
so both styles work: return a partial and it is merged into the store, or write
onto `store` directly and return nothing. Enrichers that return a partial behave
exactly as before.

The config stub now documents both styles, and that the enricher's second
argument is the caller's request object typed as `unknown` (it also runs outside
HTTP, via `Context.runEnrichers`), so it has to be narrowed before use.
