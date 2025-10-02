// src/commands/registry.ts
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

// Extra slash commands implemented as modules (each exports `data` + `execute`)
import * as pnw_bankpeek from "./pnw_bankpeek";
import * as pnw_tax_apply from "./pnw_tax_apply";
import * as treasury from "./treasury";
import * as safekeeping_adjust from "./safekeeping_adjust"; // NEW
import * as manual_adjust_log_channel from "./manual_adjust_log_channel";
import * as safekeeping_history from "./safekeeping_history";
import * as market_value from './market_value';
import * as who from './who';
import * as send from './send';
import * as guild_link_alliance from "./guild_link_alliance";
import * as guild_unlink_alliance from "./guild_unlink_alliance";
import * as offshore_set from "./offshore_set";
import * as offshore from "./offshore";


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
  manual_adjust_log_channel,
  safekeeping_history,
  market_value,
  who,
  send,
  guild_link_alliance,
  guild_unlink_alliance,
  offshore_set,
  offshore, 
  
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
