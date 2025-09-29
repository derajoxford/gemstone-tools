// src/commands/market_value.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import {
  fetchAveragePrices,
  computeTotalValue,
  fmtMoney,
  Resource,
  PriceMap,
} from "../lib/market.js";

const prisma = new PrismaClient();

const E: Record<Resource, string> = {
  money: "💵",
  food: "🍞",
  coal: "⚫",
  oil: "🛢️",
  uranium: "☢️",
  lead: "🔩",
  iron: "⛓️",
  bauxite: "🧱",
  gasoline: "⛽",
  munitions: "💣",
  steel: "🛠️",
  aluminum: "🧪",
  credits: "🎟️",
};

const ORDER: Array<{ key: Resource; label: string }> = [
  { key: "money", label: "Money" },
  { key: "food", label: "Food" },
  { key: "coal", label: "Coal" },
  { key: "oil", label: "Oil" },
  { key: "uranium", label: "Uranium" },
  { key: "lead", label: "Lead" },
  { key: "iron", label: "Iron" },
  { key: "bauxite", label: "Bauxite" },
  { key: "gasoline", label: "Gasoline" },
  { key: "munitions", label: "Munitions" },
  { key: "steel", label: "Steel" },
  { key: "aluminum", label: "Aluminum" },
  // { key: "credits", label: "Credits" },
];

// Aliases: read from your safekeeping row in case of non-standard column names
const SAFE_ALIASES: Record<Resource, string[]> = {
  money: ["money", "cash", "bank"],
  food: ["food"],
  coal: ["coal"],
  oil: ["oil"],
  uranium: ["uranium", "uran"],
  lead: ["lead"],
  iron: ["iron"],
  bauxite: ["bauxite", "baux"],
  gasoline: ["gasoline", "gas", "fuel"],
  munitions: ["munitions", "muni", "ammo", "ammunition"],
  steel: ["steel"],
  aluminum: ["aluminum", "aluminium", "alum"],
  credits: ["credits", "credit"],
};

function readQty(safe: any, aliases: string[]): number {
  for (const k of aliases) {
    const v = (safe as any)[k];
    if (v !== undefined && v !== null) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function collectSafekeep(safe: any): Partial<Record<Resource, number>> {
  const out: Partial<Record<Resource, number>> = {};
  (Object.keys(SAFE_ALIASES) as Resource[]).forEach((res) => {
    const qty = readQty(safe, SAFE_ALIASES[res]);
    if (qty > 0) out[res] = qty;
  });
  if (out.money === undefined) out.money = readQty(safe, SAFE_ALIASES.money);
  return out;
}

export const data =
