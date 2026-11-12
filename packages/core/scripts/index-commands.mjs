#!/usr/bin/env node
/**
 * Writes dist/commands/commands.json (the Ace commands index) from the built
 * command classes, so the index can never drift from the code.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'commands');
const commands = [];
for (const file of (await readdir(dir)).sort()) {
  if (!file.endsWith('.js') || file === 'main.js') continue;
  const { default: Command } = await import(pathToFileURL(join(dir, file)).href);
  if (typeof Command?.serialize !== 'function') continue;
  commands.push({ ...Command.serialize(), filePath: `./${file}` });
}
await writeFile(
  join(dir, 'commands.json'),
  `${JSON.stringify({ version: 1, commands }, null, 2)}\n`,
);
console.log(`indexed ${commands.length} commands`);
