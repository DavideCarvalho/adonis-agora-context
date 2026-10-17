---
"@adonis-agora/context": minor
---

Drop Node.js 20 and 22: `engines.node` is now `>=24`. Node 20 reached end-of-life on 2026-04-30, and AdonisJS 7, which these packages require as a peer, needs Node 24 or later (`@adonisjs/core` declares `engines.node >=24.0.0`). The supported lines are the ones Node still maintains that AdonisJS 7 accepts: 24 and 26, both tested in CI.
