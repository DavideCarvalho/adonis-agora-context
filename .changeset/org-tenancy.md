---
'@adonis-agora/context': minor
---

Tenancy: the active tenant (organization) as a first-class part of the context, for every Agora lib to scope its data by.

- `ContextStore.tenant` (`TenantRef`: `id`, `kind`, `source`, `slug`, `role`, `chain` for nested tenants, `family`), always kept in sync with `tenantId`. A plain `tenantId` reads as a `legacy` tenant.
- `Context.setTenant()`, `Context.withTenant()`, `Context.allTenants()`, `Context.tenant()`, `Context.tenants()`, `Context.tenantChain()`, `Context.requireTenant()`, `Context.tenantFilter()`, `Context.tenantLabels()`; tenants of several families (`{ family }`).
- `tenancy` in `config/context.ts`: `enabled` (off by default), `kinds`, `required` (`TenantRequiredError`, `E_TENANT_REQUIRED`), `personal`, `trustBaggage`, `label`.
- With tenancy on, the tenant rides every carrier (even a `carrier` list or custom `serialize` that omits it) and `toBaggage()` adds `tenantKind`; a tenant in incoming baggage is ignored unless `trustBaggage` is set.
- New global slot `Symbol.for('@agora/context:tenancy')` (`version: 1`) and `tenant()`, `tenancy()`, `tenantFilter()` on the accessor slot, so libs read the tenant without importing this package.
