---
'@adonis-agora/context': minor
---

`node ace agora:doctor` and `node ace context:doctor`: one health check for every installed `@adonis-agora` lib. Context adds the checks `context.middleware`, `context.single-copy`, `context.tenancy`, `context.trust-baggage` and `context.carrier`. `node ace configure @adonis-agora/context` now registers `@adonis-agora/context/commands` in `adonisrc.ts`; existing apps add that line by hand.
