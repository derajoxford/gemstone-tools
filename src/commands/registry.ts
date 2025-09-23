// src/commands/registry.ts
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

// Treasury + banking
import * as treasury from "./treasury";
import * as treasury_add from "./treasury_add";
import * as treasury_bulk from "./treasury_bulk";

// Safekeeping + withdrawals
import * as balance from "./balance";
import * as link_nation from "./link_nation";
import * as safekeeping_edit from "./safekeeping_edit";
import * as setup_alliance from "./setup_alliance";
import * as set_review_channel from "./set_review_channel";
import * as withdraw from "./withdraw";
import * as withdraw_json from "./withdraw_json";
import * as withdraw_list from "./withdraw_list";
import * as withdraw_set from "./withdraw_set";

// PnW integration
import * as pnw_bankpeek from "./pnw_bankpeek";
import * as pnw_tax_apply from "./pnw_tax_apply";
import * as pnw_set from "./pnw_set";

// (parked ones: pnw_preview, pnw_apply, pnw_cursor, etc. are disabled)

// NEW: /who
import * as who from "./who";

export type CommandModule = {
  data?: { name?: string; toJSON?: () => any };
  execute?: (i: any) => Promise<any>;
};

export const commandModules: CommandModule[] = [
  // treasury
  treasury,
  treasury_add,
  treasury_bulk,

  // safekeeping + withdrawals
  balance,
  link_nation,
  safekeeping_edit,
  setup_alliance,
  set_review_channel,
  withdraw,
  withdraw_json,
  withdraw_list,
  withdraw_set,

  // pnw
  pnw_bankpeek,
  pnw_tax_apply,
  pnw_set,

  // misc
  who,
].filter((m) => m?.data && m?.execute);

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
  commandModules.map((m) => m.data!.toJSON());

export const executeMap = new Map<string, any>(
  commandModules.map((m) => [m.data!.name!, m])
);

export const extraCommandsJSON: any[] = [];
export function findCommandByName(name: string) {
  return commandModules.find((m) => m.data?.name === name);
}
