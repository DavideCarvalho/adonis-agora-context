import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Compiles the PUBLISHED stub inside a scratch consumer app, against the REAL `@adonisjs/*` types.
 *
 * This closes a coverage gap that is invisible to every other gate here. A `.stub` is a template that
 * no tsconfig `include` reaches, so nothing type-checks the code a user actually receives from
 * `node ace configure`. The package's own typecheck compiles `src/` against the library's own types,
 * which are trivially happy with themselves; `config_stub.spec.ts` renders the stub and checks that it
 * is non-empty and parses, but `ts.transpileModule` resolves no imports and checks no types.
 *
 * The ecosystem has now been bitten twice through that hole: three libs published 0-byte config stubs
 * (a de-backtick pass emptied the files), and `@adonis-agora/agent` published a migration whose `up()`
 * did not compile in a consumer app — a structural interface that contravariance made incompatible
 * with Lucid's contract. Both suites stayed green throughout.
 *
 * The harness resolves this package BY NAME through its `exports` map, so what is checked is the
 * shipped `dist/**\/*.d.ts` a consumer installs, not `src/`. It compiles the stub twice: as the
 * generator writes it (everything commented out), and with its sample options uncommented — which is
 * what makes the documentation inside the stub verified code rather than prose.
 */
describe('the published stub compiles in a consumer app (real @adonisjs types)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));
  const distRoot = fileURLToPath(new URL('../dist', import.meta.url));
  const distTypes = join(distRoot, 'src/index.d.ts');

  // Resolving the package by name makes a built package a precondition: a hard failure under CI
  // (where `pnpm test` gates the publish), a convenience skip on a developer machine who has not
  // built yet.
  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the rendered stub', () => {
        expect.fail(
          [
            `${distTypes} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated config COMPILES for a consumer; under CI a',
            'missing build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/context build` first', () => {});
    }
  } else {
    // A cold `tsc` over the Adonis declaration graph is a few seconds; 90s is a ceiling that will not
    // flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stub against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);

    /**
     * The other half of the stub failure mode, and the cheaper one: a stub that ships at 0 bytes.
     * `configure` publishes it without complaint and the provider falls back to defaults, so the
     * consumer gets silence instead of an error. It happened here in 0.3.2 and in two sibling libs.
     * `config_stub.spec.ts` guards the SOURCE stub; this guards what `build` actually copies into the
     * tarball.
     */
    it('ships no empty or unrenderable .stub file in dist/', () => {
      const stubs = collectStubs(distRoot);
      expect(stubs.length).toBeGreaterThan(0);
      for (const stub of stubs) {
        expect(statSync(stub).size, `${stub} is empty`).toBeGreaterThan(0);

        // Scoped to the BODY — the `{{{ … }}}` header is JavaScript, where a backtick is legal.
        // Only the body becomes Tempura's template literal, and only there do these throw.
        const body = readFileSync(stub, 'utf8').replace(/\{\{\{[\s\S]*?\}\}\}/, '');
        expect(body, `${stub}: a backtick in the body makes configure throw`).not.toContain('`');
        expect(body, `${stub}: a \${ } in the body makes configure throw`).not.toContain('${');
      }
    });
  }
});

/** Every `.stub` under `dir`, recursively. */
function collectStubs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectStubs(path);
    return entry.name.endsWith('.stub') ? [path] : [];
  });
}
