import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * What `node ace configure @adonis-agora/context` actually hands a user.
 *
 * A `.stub` is a template no tsconfig `include` reaches and no import graph touches, so the whole
 * build/typecheck/test pipeline can be green while the generator is broken. Three distinct defects
 * have shipped in this ecosystem through that hole:
 *
 * 1. **A stub emptied by tooling.** This package published a 0-byte `config/context.stub` in 0.3.2
 *    (see 20ee5d0, which emptied it while working around backticks that broke the renderer).
 *    `configure` published the blank file happily and `ContextProvider` read it with
 *    `app.config.get('context', {})` — so the consumer got a silent fallback to defaults, no error,
 *    no warning.
 * 2. **A stub that does not RENDER.** Adonis compiles a stub body with Tempura, which builds it into
 *    a JavaScript template literal, so a single backtick or `${` in a doc comment terminates that
 *    literal early and the generator throws. `@adonis-agora/authz` shipped exactly that in every
 *    published version — `configure` aborted before writing a single file, and its suite stayed green
 *    because the test rendered with its own regex instead of the real engine.
 * 3. **A stub that renders but does not COMPILE** — covered by `stub_typecheck.spec.ts`.
 *
 * Everything below therefore goes through the REAL `app.stubs` pipeline, the same one
 * `codemods.makeUsingStub` walks. An approximation of the renderer is what let defect 2 survive.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stubsRoot = resolve(packageRoot, 'stubs');
const stubPath = resolve(stubsRoot, 'config/context.stub');

/** Build + prepare the stub exactly as `codemods.makeUsingStub` does. */
async function renderStub() {
  const app = new AppFactory().create(new URL('file:///stub-render-scratch/'));
  await app.init();
  const stubs = await app.stubs.create();
  return (await stubs.build('config/context.stub', { source: stubsRoot })).prepare({});
}

describe('config/context.stub', () => {
  const raw = readFileSync(stubPath, 'utf-8');

  it('is not an empty file', () => {
    // The exact regression: this stub shipped at 0 bytes in 0.3.2, so `node ace configure`
    // published an empty config/context.ts.
    expect(raw.length).toBeGreaterThan(0);
  });

  it('keeps its body free of backticks and ${ }', () => {
    // Scoped to the BODY: the `{{{ … }}}` header is evaluated as JavaScript, where a backtick is
    // legitimate (other packages build their destination with a template literal there). Only the
    // body is compiled into Tempura's template literal, and only there do these constructs break it.
    const body = raw.replace(/\{\{\{[\s\S]*?\}\}\}/, '');

    expect(
      body,
      'a backtick in the body ends Tempura’s template literal — configure throws before writing',
    ).not.toContain('`');
    expect(
      body,
      'a ${ } in the body is evaluated as an interpolation — configure throws before writing',
    ).not.toContain('${');
  });

  it('renders through the real stubs pipeline without throwing', async () => {
    await expect(renderStub()).resolves.toBeDefined();
  });

  it('publishes to config/context.ts and produces a non-empty, useful body', async () => {
    const { attributes, contents } = await renderStub();

    expect(attributes.to).toBe('/stub-render-scratch/config/context.ts');
    expect(contents.length).toBeGreaterThan(0);
    expect(contents).toContain("import { defineConfig } from '@adonis-agora/context'");
    expect(contents).toContain('export default defineConfig({');
    expect(contents, 'unrendered template syntax left in the output').not.toMatch(/\{\{/);

    // The bug that actually bit a consumer: a custom ContextStore field must be listed in `carrier`
    // explicitly, or it silently never crosses a process boundary. The published config must make
    // that discoverable.
    expect(contents).toMatch(
      /carrier:\s*\[['"]traceId['"],\s*['"]tenantId['"],\s*['"]userRef['"]\]/,
    );
    expect(contents.toLowerCase()).toContain('process boundary');
  });

  it('produces syntactically valid TypeScript', async () => {
    const { contents } = await renderStub();

    const result = ts.transpileModule(contents, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });

    const syntaxErrors = (result.diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(syntaxErrors).toEqual([]);
  });
});
