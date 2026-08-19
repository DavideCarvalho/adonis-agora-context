---
'@adonis-agora/context': patch
---

Fix the `traceId` sample in the published `config/context.ts` stub

The commented sample read `traceId: (ctx) => ctx.request.header('x-request-id')`,
which does not compile: `header()` returns `string | undefined` while the hook is
typed `(ctx: HttpContext) => string`. Anyone who uncommented it — the whole point
of a commented sample — got `TS2322` in their own config file. It now falls back
to `randomTraceId()`, and the surrounding comment says the hook must always return
a string and where `randomTraceId` comes from.

Found by a new test that renders the stub into a scratch consumer app and compiles
it with the samples uncommented, so the documentation inside the stub is checked
code from now on rather than prose.
