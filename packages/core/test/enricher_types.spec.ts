import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `ContextEnricher` used to declare a `Partial<ContextStore> | undefined` return
 * while the JSDoc, the config stub and the docs all promised that mutating the
 * store in place and returning nothing was fine. It was not: such an enricher
 * failed to compile with TS2322 ("Type 'void' is not assignable to type
 * 'Partial<ContextStore> | undefined'"), so the documented style was unusable.
 *
 * The unit tests are transpiled by swc, which erases types without checking
 * them, so a normal spec cannot catch a regression here. This one runs the real
 * compiler over `fixtures/enricher_types.ts` — which assigns every documented
 * enricher shape to `ContextEnricher` — and asserts it type-checks clean.
 *
 * TypeScript 7 no longer ships the in-process compiler API (`ts.createProgram`) from the
 * `typescript` package, so the check spawns the real `tsc` over a dedicated tsconfig
 * (`fixtures/enricher_types.tsconfig.json`) that carries the same strict options.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tsconfig = resolve(here, 'fixtures/enricher_types.tsconfig.json');
const tsc = resolve(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin/tsc',
);

describe('ContextEnricher (type-level)', () => {
  it('accepts every documented enricher shape', () => {
    let diagnostics: string[] = [];
    try {
      execFileSync(process.execPath, [tsc, '-p', tsconfig], {
        cwd: here,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      diagnostics = `${stdout ?? ''}${stderr ?? ''}`
        .split('\n')
        .filter((line) => /error TS\d+/.test(line));
      if (diagnostics.length === 0) throw error;
    }

    expect(diagnostics).toEqual([]);
    // A cold tsc run over the Node typings takes a couple of seconds, and more when the
    // stub-typecheck spec is running its own tsc alongside — well past vitest's 5s default.
  }, 60_000);
});
