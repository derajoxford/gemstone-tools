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
} from "../lib/market.js";

const prisma = new PrismaClient();

// Simple emojis to scan rows quickly
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
  // { key: "credits", label: "Credits" }, // enable when you store credits
];

export const data = new SlashCommandBuilder()
  .setName("market_value")
  .setDescription("Show the $ market value of a member's safekeeping (avg PnW prices).")
  .addUserOption((opt) =>
    opt
      .setName("member")
      .setDescription("View another member (must exist in Member table).")
      .setRequired(false)
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const targetUser = i.options.getUser("member") ?? i.user;

  const member = await prisma.member.findFirst({
    where: { discordId: targetUser.id },
  });

  if (!member) {
    await i.editReply("No safekeeping account found for that member.");
    return;
  }

  // Safekeeping per member
  let safe = await prisma.safekeeping.findFirst({ where: { memberId: member.id } });
  if (!safe) safe = await prisma.safekeeping.create({ data: { memberId: member.id } });

  // Prices (GraphQL → REST → money-only)
  const pricing = await fetchAveragePrices().catch(() => null);
  if (!pricing) {
    await i.editReply("Market data is unavailable right now. Please try again later.");
    return;
  }
  const { prices, asOf, source } = pricing;

  // Build inline fields for valued resources (qty>0 AND price available)
  const fields: { name: string; value: string; inline: boolean }[] = [];
  let valuedAny = false;

  for (const { key, label } of ORDER) {
    const qty = Number((safe as any)[key] ?? 0);
    const price = prices[key];
    if (!qty || qty <= 0 || !Number.isFinite(price)) continue;

    const qtyStr =
      key === "money"
        ? `$${Math.round(qty).toLocaleString("en-US")}`
        : qty.toLocaleString("en-US");

    const priceStr =
      key === "money"
        ? "$1"
        : `$${Number(price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

    const value = qty * (price as number);
    const valueStr = fmtMoney(value);

    fields.push({
      name: `${E[key]} ${label}`,
      value: `**${valueStr}**\n${qtyStr} × ${priceStr}`,
      inline: true,
    });
    valuedAny = true;
  }

  // If nothing but money, still show money neatly
  if (!valuedAny) {
    const money = Number(safe.money ?? 0);
    fields.push({
      name: `${E.money} Money`,
      value: `**${fmtMoney(money)}**\n$${Math.round(money).toLocaleString("en-US")} × $1`,
      inline: true,
    });
  }

  // Total using whatever prices we have
  const total = computeTotalValue(
    {
      money: Number(safe.money ?? 0),
      food: Number(safe.food ?? 0),
      coal: Number(safe.coal ?? 0),
      oil: Number(safe.oil ?? 0),
      uranium: Number(safe.uranium ?? 0),
      lead: Number(safe.lead ?? 0),
      iron: Number(safe.iron ?? 0),
      bauxite: Number(safe.bauxite ?? 0),
      gasoline: Number(safe.gasoline ?? 0),
      munitions: Number(safe.munitions ?? 0),
      steel: Number(safe.steel ?? 0),
      aluminum: Number(safe.aluminum ?? 0),
      // credits: Number((safe as any).credits ?? 0),
    },
    prices
  );

  const embed = new EmbedBuilder()
    .setTitle(`Market Value — ${member.nationName || targetUser.username}`)
    .addFields(
      ...fields,
      { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
    )
    .setFooter({
      text: `Source: ${source} • As of ${new Date(asOf).toLocaleString()}`,
    });
    // (Intentionally omitting setTimestamp to avoid duplicate time in footer)

  await i.editReply({ embeds: [embed] });
}
