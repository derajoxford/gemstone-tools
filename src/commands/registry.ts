// src/commands/registry.ts
import * as treasury from './treasury';
import * as treasury_add from './treasury_add';
import * as treasury_bulk from './treasury_bulk';
import * as pnw_set from './pnw_set';
import * as pnw_bankpeek from './pnw_bankpeek'; 
import * as pnw_tax_apply from "./pnw_tax_apply";
import * as who from './who';

export type CommandModule = {
  data?: { name?: string; toJSON?: () => any };
  execute?: (i: any) => Promise<any>;
};

export const commandModules: CommandModule[] = [
  treasury,
  treasury_add,
  treasury_bulk,
  pnw_set,
  pnw_bankpeek,
  pnw_tax_apply,
  who,
].filter((m) => m?.data && m?.execute);

export const extraCommandsJSON = commandModules
  .map((m) => m.data?.toJSON?.())
  .filter(Boolean) as any[];

export function findCommandByName(name: string) {
  return commandModules.find((m) => m.data?.name === name);
}
