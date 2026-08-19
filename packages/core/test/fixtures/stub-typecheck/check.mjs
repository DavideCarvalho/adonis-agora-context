/**
 * Type-checks the PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/context` and `@adonisjs/*` by NAME, with the stub rendered into the file
 * `node ace configure` actually writes, compiled by a real `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's
 * OWN types, which are trivially happy with themselves; `config_stub.spec.ts` renders the stub and
 * asserts it is non-empty and syntactically valid, but `ts.transpileModule` only parses — it resolves
 * no imports and checks no types. That leaves the generated config free to reference a shape the real
 * types reject while the whole suite stays green. Two ecosystem defects came through exactly that
 * gap: three libs published 0-byte config stubs, and `@adonis-agora/agent` published a migration whose
 * `up()` did not compile in a consumer app.
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its
 * `exports` map, so what is checked is the PUBLISHED `dist/**\/*.d.ts` a consumer installs — not
 * `src/`, which a check run inside this repo would otherwise pick up. A symbol dropped from the root
 * export map fails here while the package's own typecheck stays green.
 *
 * TWO FILES ARE COMPILED, from the same rendered stub:
 *
 *   1. `config/context.ts` — the stub exactly as the generator writes it, every option commented out.
 *      This is what a consumer receives on day one, so it has to compile as shipped.
 *   2. `config/context.uncommented.ts` — the same body with the commented options UNCOMMENTED. The
 *      stub's comments are documentation: they show how to write a `traceId` hook, an `initialize`
 *      bag, both enricher styles and a custom carrier. Compiling them turns that prose into checked
 *      code, so an example that stops matching the types fails here instead of in a user's editor.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `stub_typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

const STUB = 'config/context.stub';

/**
 * Render the stub the way `@adonisjs/application`'s `Stub` class does: strip the
 * `{{{ exports({ to: ... }) }}}` destination header and keep the body verbatim.
 *
 * Deliberately strict — anything left unrendered is a hard failure rather than a silent pass. A stub
 * that grows a template construct this renderer does not model would otherwise reach `tsc` with
 * literal braces in it, which reads as a compile error nobody can explain, or worse, gets "fixed" by
 * loosening the check until it stops looking at anything.
 */
function render(stub) {
  const source = readFileSync(join(pkgRoot, 'stubs', stub), 'utf8');
  if (source.trim() === '') throw new Error(`${stub} is empty — nothing to type-check`);

  const out = source.replace(/\{\{\{[\s\S]*?\}\}\}\n/, '');
  if (out === source)
    throw new Error(`no {{{ exports() }}} header in ${stub} — render assumption broken`);

  const leftover = out.match(/\{\{.*?\}\}/);
  if (leftover) throw new Error(`unrendered template syntax ${leftover[0]} left in ${stub}`);
  return out;
}

/**
 * Turn the stub's commented-out options into live code.
 *
 * Every option line in the stub is a `// key: value,` sample inside the `defineConfig({ ... })` body,
 * so dropping the leading `// ` yields a real config object. Section markers (`// -- population ... --`)
 * stay commented: they are prose, not code.
 *
 * The samples reference things a consumer would supply themselves — a `regionForTenant` helper, the
 * `HttpContext` type, and two module-augmented store fields — so the preamble below supplies exactly
 * those, and nothing else. If a sample needs something this preamble does not provide, that is a
 * signal the sample is not self-explanatory, and the failure is the point.
 */
function uncomment(rendered) {
  const body = rendered
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)\/\/ (?!--)(.*)$/);
      return match ? `${match[1]}${match[2]}` : line;
    })
    .join('\n')
    // The generated file's own import is replaced by the preamble's, which adds what the samples use.
    .replace(/^import \{ defineConfig \} from '@adonis-agora\/context'\n/m, '');

  const preamble = [
    "import type { HttpContext } from '@adonisjs/core/http'",
    "import { defineConfig, randomTraceId } from '@adonis-agora/context'",
    '',
    "declare module '@adonis-agora/context' {",
    '  interface ContextStore {',
    '    region?: string',
    '    locale?: string',
    '  }',
    '}',
    '',
    'declare function regionForTenant(tenantId: string | undefined): string',
    '',
  ].join('\n');

  return preamble + body;
}

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the generated config
 * resolves every peer it imports (`@adonisjs/core`) plus anything the published declarations
 * transitively reference. Scoped directories are recreated as real directories so
 * `@adonis-agora/context` can be added alongside without writing into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer
 * dependency is picked up automatically instead of failing here as a confusing missing-types error.
 */
function linkDependencies(appRoot) {
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(to, entry), { recursive: true });
      for (const scoped of readdirSync(join(from, entry))) {
        symlinkSync(join(from, entry, scoped), join(to, entry, scoped));
      }
      continue;
    }
    symlinkSync(join(from, entry), join(to, entry));
  }

  // The package under test, resolved BY NAME through its `exports` map → dist/**/*.d.ts.
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/context'));
}

const appRoot = mkdtempSync(join(tmpdir(), 'context-stub-typecheck-'));
try {
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'context-stub-typecheck-app', type: 'module', private: true }, null, 2),
  );
  linkDependencies(appRoot);

  const rendered = render(STUB);
  mkdirSync(join(appRoot, 'config'), { recursive: true });
  writeFileSync(join(appRoot, 'config/context.ts'), rendered);
  writeFileSync(join(appRoot, 'config/context.uncommented.ts'), uncomment(rendered));

  /**
   * An AdonisJS app's own compiler options: NodeNext + strict. Both matter — NodeNext is what makes
   * the package's `exports` map (and therefore its published declarations) the thing being resolved,
   * and `strict` is what turns a loose sample from a silent widening into a hard error.
   */
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
        },
        include: ['config/**/*.ts'],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error('stub typecheck: FAILED — the published stub does not compile in a consumer app');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log(
  'stub typecheck: OK (config/context.stub, as shipped and with its samples uncommented)',
);
