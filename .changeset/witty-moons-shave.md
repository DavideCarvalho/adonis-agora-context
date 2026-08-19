---
'@adonis-agora/context': patch
---

Declare `engines.node` as a range instead of one exact version

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
