// src/commands/registry.ts
// Keep all command imports in this tiny file instead of editing src/index.ts.
import * as treasury from './treasury';
import * as treasury_add from './treasury_add';
// (When you add new commands later, import them here and put them in the array.)

export type CommandModule = {
  data?: { name?: string; toJSON?: () => any };
  execute?: (i: any) => Promise<any>;
};

export const commandModules: CommandModule[] = [
  treasury,
  treasury_add,
].filter((m) => m?.data && m?.execute);

// Helpers the index uses:
export const extraCommandsJSON = commandModules
  .filter((m) => m.data?.toJSON)
  .map((m) => m.data!.toJSON());

export function findCommandByName(name: string) {
  return commandModules.find((m) => m.data?.name === name);
}
