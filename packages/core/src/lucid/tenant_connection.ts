import { Context } from '../context.js';

/**
 * Lançado quando uma resolução de conexão é pedida sem tenant ativo e sem um
 * {@link TenantConnectionsConfig.sharedConnection} declarado.
 *
 * É um erro, e não um fallback silencioso para a conexão default, de propósito:
 * num app com banco por tenant, "não sei de quem é esta request" seguido de
 * "vou usar o banco padrão" é um vazamento cross-tenant, não uma degradação
 * elegante. O mesmo raciocínio do middleware `requireOrg` do authkit-client.
 */
export class NoTenantInContextError extends Error {
  constructor() {
    super(
      '@adonis-agora/context: no tenant in the active context — refusing to resolve a ' +
        'database connection. Ensure the request enters the context with a `tenantId` ' +
        '(the authkit client bridge sets it from the org claim), or declare ' +
        '`sharedConnection` if this code path is legitimately tenant-less.',
    );
    this.name = 'NoTenantInContextError';
  }
}

/** Lançado quando o tenant existe mas não há conexão mapeada para ele. */
export class UnknownTenantConnectionError extends Error {
  constructor(tenantId: string) {
    super(
      `@adonis-agora/context: no database connection mapped for tenant '${tenantId}'. Add it to \`connections\`, or use \`resolve\` to derive the name.`,
    );
    this.name = 'UnknownTenantConnectionError';
  }
}

/** Subconjunto do `Database` do Lucid que o helper usa. */
export interface LucidDatabaseLike<TClient = unknown> {
  connection(name?: string): TClient;
}

export interface TenantConnectionsConfig {
  /**
   * Deriva o nome da conexão a partir do tenant. Use quando o nome segue uma
   * convenção (`tenant_<id>`) ou vem de um registry.
   */
  resolve?: (tenantId: string) => string | undefined;
  /** Mapa estático tenant → nome da conexão. Use quando o conjunto é conhecido. */
  connections?: Record<string, string>;
  /**
   * Conexão usada quando NÃO há tenant no contexto. Ausente → fail-closed
   * (lança {@link NoTenantInContextError}). Declare apenas se os caminhos
   * sem tenant deste app forem legítimos (jobs globais, tabelas compartilhadas).
   */
  sharedConnection?: string;
}

export interface ResolveOptions {
  /** Resolve para este tenant em vez do que está no contexto. */
  tenantId?: string;
}

export interface TenantConnections {
  /** Nome da conexão Lucid do tenant atual (ou o de {@link ResolveOptions}). */
  connectionName(options?: ResolveOptions): string;
  /** O client Lucid da conexão do tenant atual. */
  client<TClient>(db: LucidDatabaseLike<TClient>, options?: ResolveOptions): TClient;
}

/**
 * Resolve a conexão Lucid do **tenant ativo** — o modelo "banco por tenant".
 *
 * Vive num subpath (`@adonis-agora/context/lucid`) porque o core da lib é
 * deliberadamente livre de banco; só quem adota este modelo importa daqui, e o
 * `@adonisjs/lucid` continua sendo um peer opcional (o helper nem o importa —
 * recebe o `db` por parâmetro).
 *
 * Pareia com o AuthKit: a ponte de contexto do `authkit-client` publica o
 * `org_id` do token como `tenantId`, então o tenant já está no contexto quando
 * a request chega no controller.
 *
 * ```ts
 * const tenancy = defineTenantConnections({ resolve: (id) => `tenant_${id}` })
 *
 * // numa query
 * await User.query({ connection: tenancy.connectionName() })
 * // ou direto no client
 * await tenancy.client(db).from('invoices').select('*')
 * ```
 */
export function defineTenantConnections(config: TenantConnectionsConfig): TenantConnections {
  if (!config.resolve && !config.connections) {
    throw new Error(
      '@adonis-agora/context: defineTenantConnections requires either `resolve` or `connections`.',
    );
  }

  const nameFor = (options?: ResolveOptions): string => {
    const tenantId = options?.tenantId ?? Context.tenantId();
    if (tenantId === undefined || tenantId === '') {
      if (config.sharedConnection !== undefined) return config.sharedConnection;
      throw new NoTenantInContextError();
    }
    const resolved = config.resolve?.(tenantId) ?? config.connections?.[tenantId];
    if (resolved === undefined) throw new UnknownTenantConnectionError(tenantId);
    return resolved;
  };

  return {
    connectionName: nameFor,
    client<TClient>(db: LucidDatabaseLike<TClient>, options?: ResolveOptions): TClient {
      // O nome é resolvido ANTES de tocar no `db`: se não há tenant, nunca
      // chegamos a pedir uma conexão (pedir sem nome devolveria a default).
      const name = nameFor(options);
      return db.connection(name);
    },
  };
}
