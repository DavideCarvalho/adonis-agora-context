# @adonis-agora/context

## 0.5.1

### Patch Changes

- [#26](https://github.com/DavideCarvalho/adonis-agora-context/pull/26) [`2ad6da5`](https://github.com/DavideCarvalho/adonis-agora-context/commit/2ad6da5dc5ccf2e303079970dc3173a59c0f54b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix the `traceId` sample in the published `config/context.ts` stub

  The commented sample read `traceId: (ctx) => ctx.request.header('x-request-id')`,
  which does not compile: `header()` returns `string | undefined` while the hook is
  typed `(ctx: HttpContext) => string`. Anyone who uncommented it — the whole point
  of a commented sample — got `TS2322` in their own config file. It now falls back
  to `randomTraceId()`, and the surrounding comment says the hook must always return
  a string and where `randomTraceId` comes from.

  Found by a new test that renders the stub into a scratch consumer app and compiles
  it with the samples uncommented, so the documentation inside the stub is checked
  code from now on rather than prose.

## 0.5.0

### Minor Changes

- [#21](https://github.com/DavideCarvalho/adonis-agora-context/pull/21) [`15248e7`](https://github.com/DavideCarvalho/adonis-agora-context/commit/15248e707e7db34044a3717e90468ea7d6db5472) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ContextEnricher` now accepts an enricher that mutates the store in place

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

### Patch Changes

- [#22](https://github.com/DavideCarvalho/adonis-agora-context/pull/22) [`0d67dc4`](https://github.com/DavideCarvalho/adonis-agora-context/commit/0d67dc4a5fc80c57130a0eb7aa6ed55a1cebeedd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare `engines.node` as a range instead of one exact version

  The manifest pinned `"node": "v26.7.0"` — an exact version, not a range. npm reads
  that as "this build of Node and no other", so **every** consumer not running that
  exact version got an `EBADENGINE` warning on install, and anyone with
  `engine-strict` enabled (or a package manager that treats engines as a hard gate)
  failed the install outright. Nothing in the package justified it: the only runtime
  dependencies on Node itself are `node:async_hooks` (`AsyncLocalStorage`, including
  `enterWith`) and `node:crypto`'s `randomFillSync`, all stable long before Node 20.

  It is now `">=20.6.0"` — the floor the documentation already stated and the one the
  sibling packages declare. CI runs comfortably above it. Note that the floor an
  application actually gets is whichever is higher between this and the peer
  `@adonisjs/core`, which npm enforces from that package's own manifest; there is no
  reason for this package to restate it.

  A test now asserts that every published manifest in the workspace declares
  `engines.node` as a lower-bounded range, so an exact pin cannot come back unnoticed.

## 0.4.0

### Minor Changes

- [`d9babbd`](https://github.com/DavideCarvalho/adonis-context/commit/d9babbd217e93c9fb8971251fcc8d98029363d2d) - `contextAccessor.get(key)` agora aceita uma chave e devolve aquele campo do store; `get()` sem
  argumento segue devolvendo o store inteiro.

  O slot `@agora/context:accessor` tinha dois consumidores que discordavam do contrato de `get`:
  `@adonis-agora/telescope` e `@adonis-agora/resilience` chamam `get()` e esperam o store;
  `@adonis-agora/authz` chama `get('globalRoles')` e esperava o valor da chave. Como o accessor só
  implementava `get()`, o authz recebia o store inteiro, seu `Array.isArray` falhava, e
  `globalRolesFromContext()` devolvia `[]` — toda checagem de permissão baseada em role global negava,
  em silêncio. A forma sem argumento fica byte-idêntica, então telescope e resilience não mudam.

## 0.3.3

### Patch Changes

- [#4](https://github.com/DavideCarvalho/adonis-context/pull/4) [`0bcca12`](https://github.com/DavideCarvalho/adonis-context/commit/0bcca12d8934fb169fcc38894c845377caaa4f8d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Repopulate the `config/context.ts` stub, which shipped as a 0-byte file since 0.3.2. `node ace configure @adonis-agora/context` was publishing an empty config into consuming apps; `ContextProvider` reads it with `app.config.get('context', {})`, so this silently fell back to defaults with no error and no warning — most notably meaning a custom (module-augmented) `ContextStore` field would never be listed in `carrier` and would silently be dropped at every process boundary (queue/durable). The stub is rewritten without the backticks that broke the tempura stub renderer (the cause of the earlier emptying in 20ee5d0), documents every `ContextConfig` option, and is now covered by a test that renders it through the exact `@adonisjs/application` stub pipeline (tempura) to catch a regression before it ships.

## 0.3.2

### Patch Changes

- Export the `configure` hook from the package root so `node ace configure @adonis-agora/context` resolves it (ace imports the package root and looks for a `configure` export). Previously it lived only on the `./configure` subpath and ace could not find it.
- Remove markdown backticks from the published config stub comments; the AdonisJS (tempura) stub renderer treats the stub body as a template literal, so a stray backtick broke `node ace configure`.

## 0.3.1

### Patch Changes

- [`b3cdb20`](https://github.com/DavideCarvalho/adonis-context/commit/b3cdb20f570ccdffd527662407e7d557d5ccdc91) - fix: sync VERSION literal via sync-version guard; contextScope upholds the traceId invariant

## 0.3.0

### Minor Changes

- [`efdb64e`](https://github.com/DavideCarvalho/adonis-context/commit/efdb64ed958d0748d01860a7cc4ce3e14659f2e7) - feat: publish scoped @agora/context:scope slot; deserialize tolerates absent carrier; fix cross-process docs examples

### Patch Changes

- [`c4091a4`](https://github.com/DavideCarvalho/adonis-context/commit/c4091a4acb222bc4a73bc0e348059f35dd1cdb6b) - Better cross-process docs: concrete @adonisjs/queue example + note durable auto-propagates context

## 0.2.0

### Minor Changes

- [`1dc1eac`](https://github.com/DavideCarvalho/adonis-context/commit/1dc1eac813ad462878e2a0e5f44f2a18be89e1b9) - Publish a @agora/context:set write slot for structural context population by sibling libs

- [`93fe34b`](https://github.com/DavideCarvalho/adonis-context/commit/93fe34b0cc0f80383ec7f7f654d2992efeab98eb) - Require AdonisJS v7 (bump @adonisjs/core peer to the v7 line)
