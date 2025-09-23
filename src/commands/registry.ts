// src/commands/registry.ts
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

// ✅ Only include commands we’ve explicitly migrated into registry
import * as pnw_bankpeek from "./pnw_bankpeek";

export const commandModules = [
  pnw_bankpeek,
].filter((m) => m?.data && m?.execute);

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
  commandModules.map((m) => m.data!.toJSON());

export const executeMap = new Map<string, any>(
  commandModules.map((m) => [m.data!.name!, m])
);

// ---- TEMP STUBS (to keep build green for legacy paths) ----
export const extraCommandsJSON: any[] = [];
export function findCommandByName(_name: string) {
  return undefined as any;
}
