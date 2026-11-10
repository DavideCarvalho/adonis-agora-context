#!/usr/bin/env node
/**
 * Runs publint and @arethetypeswrong/cli against every non-private package
 * under packages/. Expects the packages to be built already (`pnpm build`).
 * attw uses the `esm-only` profile for packages with `"type": "module"`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

let failed = 0;

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgDir = join(packagesDir, entry.name);
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (pkg.private === true) continue;

  const attwArgs = ['attw', '--pack', '.'];
  if (pkg.type === 'module') attwArgs.push('--profile', 'esm-only');

  for (const [label, args] of [
    ['publint', ['publint', '--strict']],
    ['attw', attwArgs],
  ]) {
    console.log(`\n> ${pkg.name}: ${label}`);
    try {
      execFileSync('pnpm', ['exec', ...args], { cwd: pkgDir, stdio: 'inherit' });
    } catch {
      failed++;
      console.error(`${label} failed for ${pkg.name}`);
    }
  }
}

if (failed > 0) process.exit(1);
