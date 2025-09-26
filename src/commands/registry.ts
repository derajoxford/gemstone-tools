// src/commands/registry.ts
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

// Extra slash commands implemented as modules (each exports `data` + `execute`)
import * as pnw_bankpeek from "./pnw_bankpeek";
import * as pnw_tax_apply from "./pnw_tax_apply";
import * as treasury from "./treasury";
import * as safekeeping_adjust from "./safekeeping_adjust"; // NEW

export type CommandModule = {
  data?: { name?: string; toJSON?: () => any };
  execute?: (i: any) => Promise<any>;
};

// Only include modules that actually expose both `data` and `execute`
export const commandModules: CommandModule[] = [
  pnw_bankpeek,
  pnw_tax_apply,
  treasury,
  safekeeping_adjust,
].filter((m) => m?.data && m?.execute);

// JSON payloads for registration (consumed by src/index.ts)
export const extraCommandsJSON: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
  commandModules
    .map((m) => m.data?.toJSON?.())
    .filter(Boolean) as RESTPostAPIChatInputApplicationCommandsJSONBody[];

// Lookup helper used by src/index.ts to dispatch to module.execute
export function findCommandByName(name: string) {
  return commandModules.find((m) => m.data?.name === name);
}
