import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import ContextProvider from '../providers/context_provider.js';
import { CONTEXT_TENANCY, tenancySlot } from '../src/accessor.js';
import {
  AgoraDoctorUsageError,
  readDoctorChecks,
  runAgoraDoctor,
} from '../src/doctor/agora_doctor.js';
import {
  checkCarrier,
  checkMiddleware,
  checkSingleCopy,
  checkTenancy,
  checkTrustBaggage,
  registerContextDoctorChecks,
} from '../src/doctor/checks.js';

class FakeContainer {
  values = new Map<string, unknown>();
  hasBinding(key: string) {
    return this.values.has(key);
  }
  bindValue(key: string, value: unknown) {
    this.values.set(key, value);
  }
  async make(key: string) {
    return this.values.get(key);
  }
}

function fakeApp(config: object, options: { root?: string; production?: boolean } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'ctx-doctor-'));
  return {
    isReady: true,
    inProduction: options.production === true,
    nodeEnvironment: options.production ? 'production' : 'development',
    container: new FakeContainer(),
    config: { get: (key: string, fallback?: unknown) => (key === 'context' ? config : fallback) },
    makePath: (...parts: string[]) => join(root, ...parts),
  } as unknown as ApplicationService & { container: FakeContainer };
}

function appWithKernel(kernel: string) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-doctor-'));
  mkdirSync(join(root, 'start'));
  writeFileSync(join(root, 'start', 'kernel.ts'), kernel);
  return fakeApp({}, { root });
}

afterEach(() => {
  (globalThis as Record<symbol, unknown>)[CONTEXT_TENANCY] = tenancySlot;
});

describe('context doctor checks', () => {
  it('context.middleware', async () => {
    expect(await checkMiddleware(fakeApp({}))).toMatchObject({ status: 'skip' });
    expect(
      await checkMiddleware(
        appWithKernel("server.use([() => import('@adonis-agora/context/context_middleware')])"),
      ),
    ).toMatchObject({ status: 'ok' });
    expect(await checkMiddleware(appWithKernel('server.use([])'))).toMatchObject({
      status: 'warn',
    });
  });

  it('context.single-copy', () => {
    expect(checkSingleCopy().status).toBe('ok');
    (globalThis as Record<symbol, unknown>)[CONTEXT_TENANCY] = { version: 1 };
    expect(checkSingleCopy().status).toBe('warn');
  });

  it('context.tenancy', () => {
    expect(checkTenancy(fakeApp({}))).toEqual([{ status: 'skip', message: 'tenancy is off' }]);
    expect(checkTenancy(fakeApp({ tenancy: { required: true } }))[0]?.status).toBe('warn');
    expect(checkTenancy(fakeApp({ tenancy: { enabled: true } }))[0]?.status).toBe('warn');
    expect(checkTenancy(fakeApp({ tenancy: { enabled: true, kinds: [] } }))[0]?.status).toBe(
      'error',
    );
    expect(
      checkTenancy(
        fakeApp({ tenancy: { enabled: true, kinds: ['organization'], personal: true } }),
      ),
    ).toMatchObject([{ status: 'warn' }]);
    expect(
      checkTenancy(fakeApp({ tenancy: { enabled: true, kinds: ['organization'] } })),
    ).toMatchObject([{ status: 'ok', message: 'tenancy is on (kinds: organization)' }]);
  });

  it('context.trust-baggage', () => {
    expect(checkTrustBaggage(fakeApp({})).status).toBe('skip');
    const config = { tenancy: { enabled: true, trustBaggage: true } };
    expect(checkTrustBaggage(fakeApp(config)).status).toBe('ok');
    expect(checkTrustBaggage(fakeApp(config, { production: true })).status).toBe('warn');
  });

  it('context.carrier', () => {
    expect(checkCarrier(fakeApp({})).status).toBe('ok');
    expect(checkCarrier(fakeApp({ serialize: () => ({ traceId: 'x' }) })).status).toBe('warn');
    expect(checkCarrier(fakeApp({ deserialize: () => ({ traceId: 'x' }) })).status).toBe('warn');
  });
});

describe('registration', () => {
  it('creates the registry when absent and reuses it when present', async () => {
    const app = fakeApp({});
    await registerContextDoctorChecks(app);
    const registry = app.container.values.get('agora.doctor') as {
      version: number;
      checks: { id: string; lib: string }[];
    };
    expect(registry.version).toBe(1);
    expect(new Set(registry.checks.map((check) => check.lib))).toEqual(new Set(['context']));
    expect(registry.checks.map((check) => check.id)).toContain('context.tenancy');

    // A second registration (another copy) adds nothing.
    const count = registry.checks.length;
    await registerContextDoctorChecks(app);
    expect(registry.checks).toHaveLength(count);
  });

  it('leaves a registry of another version alone', async () => {
    const app = fakeApp({});
    app.container.bindValue('agora.doctor', { version: 2, checks: [] });
    await registerContextDoctorChecks(app);
    expect((app.container.values.get('agora.doctor') as { checks: unknown[] }).checks).toEqual([]);
  });

  it('the provider registers in register()', async () => {
    const app = fakeApp({});
    new ContextProvider(app).register();
    await Promise.resolve();
    expect(app.container.hasBinding('agora.doctor')).toBe(true);
  });
});

describe('agora:doctor with the context checks', () => {
  it('reports the context lib and exits 1 on an error', async () => {
    const app = fakeApp({ tenancy: { enabled: true, kinds: [] } });
    await registerContextDoctorChecks(app);
    const checks = await readDoctorChecks(app.container);
    const { report, exitCode } = await runAgoraDoctor(app, checks);
    expect(exitCode).toBe(1);
    expect(report.libs[0]).toMatchObject({ lib: 'context', package: '@adonis-agora/context' });
    expect(report.results.find((r) => r.id === 'context.tenancy')?.status).toBe('error');
    expect(report.results.map((r) => r.id)).toContain('context.peers');
  });

  it('rejects an unknown --only id', async () => {
    const app = fakeApp({});
    await registerContextDoctorChecks(app);
    const checks = await readDoctorChecks(app.container);
    await expect(runAgoraDoctor(app, checks, { only: 'context.nope' })).rejects.toBeInstanceOf(
      AgoraDoctorUsageError,
    );
  });

  it('the ./doctor entry exports the same checks', async () => {
    const mod = await import('../src/doctor/checks.js');
    expect(mod.agoraDoctorChecks.map((check) => check.id)).toEqual([
      'context.middleware',
      'context.single-copy',
      'context.tenancy',
      'context.trust-baggage',
      'context.carrier',
    ]);
  });
});
