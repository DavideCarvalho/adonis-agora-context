import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
 */

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/enricher_types.ts');

describe('ContextEnricher (type-level)', () => {
  it('accepts every documented enricher shape', () => {
    const program = ts.createProgram([fixture], {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    });

    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));

    expect(diagnostics).toEqual([]);
  });
});
