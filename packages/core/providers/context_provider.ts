import type { ApplicationService } from '@adonisjs/core/types';
import { Context } from '../src/context.js';
import { type ContextConfig, setContextHttpOptions } from '../src/define_config.js';
import { wireContextIntoDiagnostics } from '../src/diagnostics_bridge.js';

/**
 * Wires `@adonis-agora/context` into the AdonisJS application.
 *
 * `boot()` runs after config is loaded, so it reads `config/context.ts`, pushes
 * the cross-boundary subset onto the module-level singleton (`Context.configure`)
 * and stashes the population hooks for {@link ContextMiddleware} to read. It also
 * registers the trace accessor with `@adonis-agora/diagnostics` when that optional peer
 * is present.
 *
 * The per-request context itself is established by the server middleware, which
 * `node ace configure @adonis-agora/context` registers on the `server` stack.
 */
export default class ContextProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = this.app.config.get<ContextConfig>('context', {});
    // The singleton lives outside the container so it can be read by queue
    // workers, durable, ace commands, and ORM hooks — push the cross-boundary
    // config (carrier/serialize/deserialize/baggage/enrichers) onto it here.
    Context.configure(config);
    // Hand the population hooks (traceHeader/traceId/initialize/enrichers) to the
    // middleware via its module-level holder.
    setContextHttpOptions(config);
    announceTenancy(config);
    await wireContextIntoDiagnostics();
  }
}

/**
 * One boot line when tenancy is on and the configured carrier would not carry
 * the tenant by itself: the tenant is added anyway, and the app should know.
 */
function announceTenancy(config: ContextConfig): void {
  if (config.tenancy?.enabled !== true) {
    return;
  }
  if (config.serialize !== undefined) {
    console.info(
      '[@adonis-agora/context] tenancy is enabled: the tenant (tenant, tenantId) is added to the output of your custom `serialize` when it is missing.',
    );
    return;
  }
  const carrier = config.carrier;
  if (carrier !== undefined && !(carrier.includes('tenantId') && carrier.includes('tenant'))) {
    console.info(
      '[@adonis-agora/context] tenancy is enabled: the tenant (tenant, tenantId) is added to every carrier, even though `carrier` in config/context.ts does not list it.',
    );
  }
}
