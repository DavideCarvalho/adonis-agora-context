---
"@adonis-agora/context": minor
---

Novo subpath `@adonis-agora/context/lucid`: resolve a conexão Lucid do tenant ativo, fail-closed

O contexto já carrega `tenantId`. Num app com **banco por tenant**, esse valor é
a única coisa entre a request e a conexão certa — mas transformar um no outro
era código solto em cada app, e o jeito errado de escrever é curto demais:

```ts
db.connection(`tenant_${Context.tenantId()}`)   // sem tenant → 'tenant_undefined'
db.connection(map[Context.tenantId()])          // sem tenant → a conexão DEFAULT
```

`defineTenantConnections({ resolve })` faz isso recusando adivinhar:

- **Sem tenant no contexto → lança `NoTenantInContextError`.** Não cai na conexão
  default. Em banco-por-tenant, "não sei de quem é esta request, vou usar o banco
  padrão" é vazamento cross-tenant fantasiado de degradação elegante. Mesmo
  raciocínio do middleware `requireOrg` do authkit-client.
- **`client(db)` resolve o nome ANTES de tocar no `db`** — uma chamada sem tenant
  nunca chega em `db.connection()`, porque chamar sem argumento É o vazamento.
- **Tenant sem conexão mapeada → `UnknownTenantConnectionError`**, nunca o default.
- **`sharedConnection` é opt-in explícito**, para os caminhos que de fato não têm
  tenant (job global, tabela compartilhada).
- **`connectionName({ tenantId })`** resolve um tenant específico, para jobs que
  varrem vários.

Fica num subpath porque o core da lib é deliberadamente livre de banco: o helper
não importa `@adonisjs/lucid` (recebe o `db` por parâmetro), então o peer segue
opcional e quem não usa o modelo não carrega nada.

Pareia direto com o AuthKit: a ponte de contexto do `authkit-client` publica a
claim `org_id` como `tenantId`, então o tenant já está no contexto quando a
request chega no controller.
