import type { Client } from "discord.js";
import type { PrismaClient } from "@prisma/client";

/**
 * Temporary no-op job so src/index.ts can import it safely.
 * Replace with real logic later.
 */

export async function startAutoApply(_client?: Client, _prisma?: PrismaClient) {
  // no-op
}

// Include these in case index.ts (or future code) imports other variants.
export async function schedulePNWAutoApply(_client?: Client, _prisma?: PrismaClient) {
  // no-op
}

export async function start(_client?: Client, _prisma?: PrismaClient) {
  // no-op
}

export default { startAutoApply, schedulePNWAutoApply, start };
