import { describe, expect, it } from 'vitest';
import { Context } from '../src/context.js';
import { NoTenantInContextError, defineTenantConnections } from '../src/lucid/tenant_connection.js';

/** Roda `fn` dentro de um contexto com (ou sem) tenant. */
function withTenant<T>(tenantId: string | undefined, fn: () => T): T {
  return Context.run({ traceId: 't-1', tenantId }, fn);
}

describe('tenantConnections — resolução do nome', () => {
  it('resolve o nome da conexão a partir do tenant do contexto', () => {
    const tenancy = defineTenantConnections({ resolve: (id) => `tenant_${id}` });
    expect(withTenant('acme', () => tenancy.connectionName())).toBe('tenant_acme');
  });

  it('aceita um mapa estático em vez de função', () => {
    const tenancy = defineTenantConnections({ connections: { acme: 'acme_db', globex: 'gx' } });
    expect(withTenant('globex', () => tenancy.connectionName())).toBe('gx');
  });

  it('mapa sem entrada para o tenant é erro — jamais silêncio', () => {
    const tenancy = defineTenantConnections({ connections: { acme: 'acme_db' } });
    expect(() => withTenant('desconhecido', () => tenancy.connectionName())).toThrow(
      /desconhecido/,
    );
  });
});

describe('tenantConnections — fail-closed', () => {
  it('sem tenant no contexto, LANÇA em vez de cair na conexão default', () => {
    // Este é o ponto inteiro do helper: cair no banco default por acidente é
    // vazamento cross-tenant, não um fallback simpático.
    const tenancy = defineTenantConnections({ resolve: (id) => `tenant_${id}` });
    expect(() => withTenant(undefined, () => tenancy.connectionName())).toThrow(
      NoTenantInContextError,
    );
  });

  it('fora de qualquer contexto também lança', () => {
    const tenancy = defineTenantConnections({ resolve: (id) => `tenant_${id}` });
    expect(() => tenancy.connectionName()).toThrow(NoTenantInContextError);
  });

  it('o fallback compartilhado só vale quando declarado EXPLICITAMENTE', () => {
    const tenancy = defineTenantConnections({
      resolve: (id) => `tenant_${id}`,
      sharedConnection: 'public',
    });
    expect(withTenant(undefined, () => tenancy.connectionName())).toBe('public');
  });
});

describe('tenantConnections — cliente Lucid', () => {
  /** Duplo mínimo do Database do Lucid: só o que o helper usa. */
  function fakeDb() {
    const asked: string[] = [];
    return {
      asked,
      connection(name?: string) {
        asked.push(name ?? '<default>');
        return { __name: name };
      },
    };
  }

  it('client() pede ao Lucid a conexão do tenant atual', () => {
    const tenancy = defineTenantConnections({ resolve: (id) => `tenant_${id}` });
    const db = fakeDb();
    const client = withTenant('acme', () => tenancy.client(db as any));
    expect(db.asked).toEqual(['tenant_acme']);
    expect((client as any).__name).toBe('tenant_acme');
  });

  it('client() nunca chama connection() sem nome (o default é o vazamento)', () => {
    const tenancy = defineTenantConnections({ resolve: (id) => `tenant_${id}` });
    const db = fakeDb();
    expect(() => withTenant(undefined, () => tenancy.client(db as any))).toThrow(
      NoTenantInContextError,
    );
    expect(db.asked).toEqual([]);
  });
});

describe('tenantConnections — escopo explícito', () => {
  it('connectionName({ tenantId }) resolve um tenant específico, ignorando o contexto', () => {
    const tenancy = defineTenantConnections({ resolve: (id) => `tenant_${id}` });
    expect(withTenant('acme', () => tenancy.connectionName({ tenantId: 'outro' }))).toBe(
      'tenant_outro',
    );
  });
});
