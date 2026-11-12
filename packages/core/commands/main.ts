import { readFile } from 'node:fs/promises';

interface CommandMetaData {
  commandName: string;
  filePath: string;
  [key: string]: unknown;
}

let metaData: CommandMetaData[] | undefined;

/** Ace commands loader: the metadata of this package's commands. */
export async function getMetaData(): Promise<CommandMetaData[]> {
  if (metaData === undefined) {
    const index = await readFile(new URL('./commands.json', import.meta.url), 'utf8');
    metaData = (JSON.parse(index) as { commands: CommandMetaData[] }).commands;
  }
  return metaData;
}

/** Ace commands loader: import one command class by name. */
export async function getCommand(command: { commandName: string }): Promise<unknown> {
  const found = (await getMetaData()).find((entry) => entry.commandName === command.commandName);
  if (found === undefined) {
    return null;
  }
  const module = (await import(new URL(found.filePath, import.meta.url).href)) as {
    default: unknown;
  };
  return module.default;
}
