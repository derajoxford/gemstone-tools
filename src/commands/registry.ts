// src/commands/registry.ts
import * as treasury from './treasury';
import * as treasury_add from './treasury_add';
import * as treasury_bulk from './treasury_bulk';
import * as pnw_preview from './pnw_preview';
import * as pnw_set from './pnw_set';
import * as pnw_preview_stored from './pnw_preview_stored';
import * as pnw_apply from './pnw_apply';

export type CommandModule = {
  data?: { name?: string; toJSON?: () => any };
  execute?: (i: any) => Promise<any>;
};

export const commandModules: CommandModule[] = [
  treasury,
  treasury_add,
  treasury_bulk,
  pnw_preview,
  pnw_set,
  pnw_preview_stored,
  pnw_apply,
].filter((m) => m?.data && m?.execute);

export const extraCommandsJSON = commandModules
  .map((m) => m.data?.toJSON?.())
  .filter(Boolean) as any[];

export function findCommandByName(name: string) {
  return commandModules.find((m) => m.data?.name === name);
}
