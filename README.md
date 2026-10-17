# `@adonis-agora/context`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/context)](https://www.npmjs.com/package/@adonis-agora/context) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/context)](https://www.npmjs.com/package/@adonis-agora/context) [![CI](https://github.com/DavideCarvalho/adonis-agora-context/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-context/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/context)](https://www.npmjs.com/package/@adonis-agora/context)

> Shared AsyncLocalStorage context for **AdonisJS** — carries `user` / `tenant` /
> `traceId` across the request **and** the [Agora](#the-agora-ecosystem)
> ecosystem (HTTP, queue workers, durable, ace commands).

AdonisJS already ships an ALS-backed `HttpContext` — but it only lives **inside an
HTTP request** (`HttpContext.getOrFail()` throws outside one). `@adonis-agora/context` is
the thin, serializable layer that crosses the boundaries `HttpContext` can't:
`@adonisjs/queue` workers, durable workflows, ace commands, and ORM hooks.

## Install

```sh
npm i @adonis-agora/context
node ace configure @adonis-agora/context
```

`configure` registers the provider, plugs the context middleware onto the `server`
stack, and publishes `config/context.ts`.

## Use

```ts
import { Context } from '@adonis-agora/context'

// anywhere — HTTP handler, service, queue worker, ace command:
Context.traceId()   // current trace id
Context.tenantId()  // current tenant
Context.userRef()   // { type, id } — never the full user entity

// after auth, stamp the principal onto the active context:
Context.set('userRef', { type: 'user', id: user.id })
```

Carry the context across a queue/process boundary:

```ts
queue.dispatch('send-email', { ...payload, __ctx: Context.serialize() })
// in the worker:
Context.deserialize(job.__ctx, () => handler(job))
```

See [`DESIGN.md`](./DESIGN.md) for the full contract (customization levels,
cross-boundary semantics, W3C baggage).

## Packages

| Entry point | What |
|---|---|
| [`@adonis-agora/context`](./packages/core) [![npm](https://img.shields.io/npm/v/@adonis-agora/context)](https://www.npmjs.com/package/@adonis-agora/context) | core — ALS, middleware, provider, config, serialize, baggage, traceparent |
| [`@adonis-agora/context/testing`](./packages/core/src/testing) | `runWithContext()` / `enterContext()` test helpers |

## The Agora ecosystem

Agora is the AdonisJS port of the [aviary](https://github.com/DavideCarvalho?tab=repositories)
NestJS ecosystem. `@adonis-agora/context` is the foundation other Agora libs build on
(diagnostics, telescope, authz, filter, durable).

## License

MIT © Davi Carvalho
