import { readFile } from 'node:fs/promises';
import type { ApplicationService } from '@adonisjs/core/types';
import { CONTEXT_TENANCY, tenancySlot } from '../accessor.js';
import type { ContextConfig } from '../define_config.js';

import {
  type AgoraDoctorCheck,
  type AgoraDoctorResult,
  registerDoctorChecks,
} from './agora_doctor.js';

/*
 * `agora:doctor` checks for @adonis-agora/context. Exported as `agoraDoctorChecks`
 * (the `./doctor` entry, read by `agora:doctor --no-boot`) and registered by the provider.
 */

type DoctorResult = AgoraDoctorResult;

const DOCS = 'https://davidecarvalho.github.io/agora/docs/context';

function contextConfig(app: ApplicationService): ContextConfig {
  return app.config.get<ContextConfig>('context', {}) ?? {};
}

/** `context.middleware`: the context middleware is on the server stack. */
export async function checkMiddleware(app: ApplicationService): Promise<DoctorResult> {
  let kernel: string;
  try {
    kernel = await readFile(app.makePath('start', 'kernel.ts'), 'utf8');
  } catch {
    return { status: 'skip', message: 'start/kernel.ts not found' };
  }
  if (kernel.includes('@adonis-agora/context/context_middleware')) {
    return { status: 'ok', message: 'context_middleware is registered in start/kernel.ts' };
  }
  return {
    status: 'warn',
    message:
      'context_middleware is not registered: requests run with no context (no traceId, user or tenant)',
    fix: "Add () => import('@adonis-agora/context/context_middleware') to server.use() in start/kernel.ts",
    docs: `${DOCS}/getting-started`,
  };
}

/** `context.single-copy`: the global slots belong to this copy of the package. */
export function checkSingleCopy(): DoctorResult {
  const slot = (globalThis as Record<symbol, unknown>)[CONTEXT_TENANCY];
  if (slot === tenancySlot) {
    return { status: 'ok', message: 'one copy of @adonis-agora/context is loaded' };
  }
  return {
    status: 'warn',
    message:
      'another copy of @adonis-agora/context replaced the global slots: libs may read a different context than your app writes',
    fix: 'Install a single version of @adonis-agora/context (pnpm why @adonis-agora/context, then pnpm dedupe)',
  };
}

/** `context.tenancy`: tenancy options are coherent. */
export function checkTenancy(app: ApplicationService): DoctorResult[] {
  const tenancy = contextConfig(app).tenancy;
  if (tenancy?.enabled !== true) {
    const stray = tenancy && (tenancy.required || tenancy.personal || tenancy.kinds);
    if (stray) {
      return [
        {
          status: 'warn',
          message: 'tenancy options are set but tenancy.enabled is not true: they have no effect',
          fix: 'Set tenancy.enabled: true in config/context.ts, or remove the tenancy block',
          docs: `${DOCS}/tenancy`,
        },
      ];
    }
    return [{ status: 'skip', message: 'tenancy is off' }];
  }
  const out: DoctorResult[] = [];
  if (tenancy.kinds !== undefined && tenancy.kinds.length === 0) {
    out.push({
      status: 'error',
      message: 'tenancy.kinds is empty: no tenant will ever match, every request is tenantless',
      fix: "List the tenant kinds you use, e.g. kinds: ['organization']",
      docs: `${DOCS}/tenancy`,
    });
  } else if (tenancy.kinds === undefined) {
    out.push({
      status: 'warn',
      message:
        'tenancy.kinds is not set: tenants of any kind, including a plain tenantId of unknown kind, scope data',
      fix: "Set tenancy.kinds in config/context.ts, e.g. kinds: ['organization']",
      docs: `${DOCS}/tenancy`,
    });
  }
  if (tenancy.personal === true && tenancy.kinds !== undefined && !tenancy.kinds.includes('user')) {
    out.push({
      status: 'warn',
      message:
        "tenancy.personal is on but 'user' is not in tenancy.kinds: personal tenants are ignored",
      fix: "Add 'user' to tenancy.kinds",
      docs: `${DOCS}/tenancy`,
    });
  }
  if (out.length === 0) {
    out.push({
      status: 'ok',
      message: `tenancy is on (kinds: ${(tenancy.kinds ?? []).join(', ')}${tenancy.required ? ', required' : ''})`,
    });
  }
  return out;
}

/** `context.trust-baggage`: a tenant from the network is only trusted on purpose. */
export function checkTrustBaggage(app: ApplicationService): DoctorResult {
  const tenancy = contextConfig(app).tenancy;
  if (tenancy?.enabled !== true) {
    return {
      status: 'skip',
      message: 'tenancy is off (Context.fromBaggage still restores a plain tenantId)',
    };
  }
  if (tenancy.trustBaggage !== true) {
    return {
      status: 'skip',
      message: 'incoming baggage cannot set the tenant (trustBaggage is off)',
    };
  }
  return {
    status: app.inProduction ? 'warn' : 'ok',
    message:
      'tenancy.trustBaggage is on: any caller that reaches Context.fromBaggage() can pick the tenant',
    fix: 'Keep it only behind a gateway that strips client baggage, or turn it off',
    docs: `${DOCS}/tenancy`,
  };
}

/** `context.carrier`: custom fields the app listed survive the boundary. */
export function checkCarrier(app: ApplicationService): DoctorResult {
  const config = contextConfig(app);
  if (config.serialize !== undefined && config.deserialize === undefined) {
    return {
      status: 'warn',
      message:
        'a custom serialize is set without a matching deserialize: custom carrier fields are dropped on restore',
      fix: 'Add deserialize next to serialize in config/context.ts',
      docs: `${DOCS}/cross-process`,
    };
  }
  if (config.deserialize !== undefined && config.serialize === undefined) {
    return {
      status: 'warn',
      message: 'a custom deserialize is set without a matching serialize',
      fix: 'Add serialize next to deserialize in config/context.ts',
      docs: `${DOCS}/cross-process`,
    };
  }
  return { status: 'ok', message: 'carrier configuration is consistent' };
}

export const agoraDoctorChecks: AgoraDoctorCheck[] = [
  { id: 'context.middleware', lib: 'context', title: 'Context middleware', run: checkMiddleware },
  { id: 'context.single-copy', lib: 'context', title: 'One copy loaded', run: checkSingleCopy },
  { id: 'context.tenancy', lib: 'context', title: 'Tenancy configuration', run: checkTenancy },
  {
    id: 'context.trust-baggage',
    lib: 'context',
    title: 'Tenant from incoming baggage',
    run: checkTrustBaggage,
  },
  { id: 'context.carrier', lib: 'context', title: 'Carrier configuration', run: checkCarrier },
];

/** Add this package's checks to the shared `'agora.doctor'` registry. Never throws. */
export async function registerContextDoctorChecks(app: { container: unknown }): Promise<void> {
  try {
    await registerDoctorChecks(
      app.container as Parameters<typeof registerDoctorChecks>[0],
      agoraDoctorChecks,
    );
  } catch {
    // The doctor is best effort: a broken registry never breaks the app.
  }
}
