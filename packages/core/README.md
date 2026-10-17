# `@adonis-agora/context`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/context)](https://www.npmjs.com/package/@adonis-agora/context) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/context)](https://www.npmjs.com/package/@adonis-agora/context) [![CI](https://github.com/DavideCarvalho/adonis-agora-context/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-context/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/context)](https://www.npmjs.com/package/@adonis-agora/context)

Shared AsyncLocalStorage context for AdonisJS — carries `user` / `tenant` /
`traceId` across the request and the Agora ecosystem (HTTP, queue workers,
durable, ace commands).

```sh
npm i @adonis-agora/context
node ace configure @adonis-agora/context
```

```ts
import { Context } from '@adonis-agora/context'
Context.traceId()
Context.set('userRef', { type: 'user', id: user.id })
```

See the [repository README](https://github.com/DavideCarvalho/adonis-context) and
`DESIGN.md` for the full contract.

## License

MIT © Davi Carvalho
