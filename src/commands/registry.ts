// src/commands/registry.ts
// Keep add-on command imports here so you don't have to touch src/index.ts

import * as treasury_bulk from './treasury_bulk';

export type CommandModule = {
  data?: { name?: string; toJSON?: () => any };
  execute?: (i: any) => Promise<any>;
};

// Only include commands that are NOT already registered in src/index.ts
export const commandModules: CommandModule[] = [
  treasury_bulk,
].filter((m) => m?.data && m?.execute);

// JSON payloads used during registration
export const extraCommandsJSON = commandModules
  .filter((m) => m.data?.toJSON)
  .map((m) => m.data!.toJSON());

// Runtime lookup so index.ts can execute by name
export function findCommandByName(name: string) {
  return commandModules.find((m) => m.data?.name === name);
}
