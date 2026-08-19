import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `engines.node` used to be pinned to a single exact version (`"v26.7.0"`), which
 * is not a range: every consumer on any other Node got an `EBADENGINE` warning on
 * install, and anyone running with `engine-strict` failed outright — for a package
 * whose only runtime needs are `node:async_hooks` and `node:crypto`.
 *
 * An exact pin is the kind of declaration nobody ever reads back, so it is asserted
 * here: a published manifest has to state a lower-bounded RANGE.
 */

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every workspace package that is actually published (`private: true` is skipped). */
function publishableManifests(): { name: string; engines?: { node?: string } }[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'package.json'))
    .flatMap((path) => {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf-8');
      } catch {
        return [];
      }
      const manifest = JSON.parse(raw);
      return manifest.private === true ? [] : [manifest];
    });
}

describe('published package manifests', () => {
  const manifests = publishableManifests();

  it('finds at least one publishable package', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests.map((m) => [m.name, m] as const))(
    '%s declares engines.node as a lower-bounded range, not an exact version',
    (_name, manifest) => {
      const node = manifest.engines?.node;
      expect(node).toBeDefined();

      // `"v26.7.0"` / `"26.7.0"` — an exact version with no comparator. npm reads
      // this as "this and nothing else", so every other Node is out of range.
      expect(node).not.toMatch(/^v?\d+(\.\d+)*$/);

      // What a range looks like: a lower bound, optionally with an upper one.
      // e.g. `>=20.6.0`, `>=20.6.0 <25`, `^22.0.0`.
      expect(node).toMatch(/^(>=?|\^|~)\s*\d+(\.\d+)*/);

      // A leading `v` is tolerated by semver but reads as a pin; keep it out.
      expect(node).not.toMatch(/\bv\d/);
    },
  );
});
