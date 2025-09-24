// src/commands/registry.ts
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';

// ✅ Keep ONLY commands that currently compile.
//    Right now we only ship /pnw_bankpeek from this registry.
import * as pnw_bankpeek from './pnw_bankpeek';
import * as pnw_tax_apply from "./pnw_tax_apply";

export const extraCommandsJSON: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  pnw_bankpeek.data.toJSON(),
  pnw_tax_apply,
];

// Called by index.ts to dispatch to the command module
export function findCommandByName(name: string) {
  if (name === pnw_bankpeek.data.name) return pnw_bankpeek;
  return undefined;
}
