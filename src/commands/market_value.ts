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

// Order & labels for display
const RESOURCE_ORDER: Array<{ key: Resource; label: string }> = [
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
  // { key: "credits", label: "Credits" }, // enable if you store credits
];

export const data = new SlashCommandBuilder()
  .setName("market_value")
  .setDescription("Show the $ market value of a member's safekeeping (avg PnW prices).")
  .addUserOption((opt) =>
    opt
      .setName("member")
      .setDescription("View another member (admin/banker rules still apply).")
      .setRequired(false)
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const targetUser = i.options.getUser("member") ?? i.user;

  const member = await prisma.member.findFirst({
    where: { discordId: targetUser.id },
    include: { safekeeping: true },
  });

  if (!member) {
    await i.editReply("No safekeeping account found for that member.");
    return;
  }

  const safe =
    member.safekeeping ??
    (await prisma.safekeeping.create({ data: { memberId: member.id } }));

  const pricing = await fetchAveragePrices().catch(() => null);

  if (!pricing) {
    await i.editReply(
      "Market data is unavailable right now. Please try again later."
    );
    return;
  }

  const { prices, asOf } = pricing;

  // Build valuation lines (only show rows with a positive quantity)
  const lines: string[] = [];
  let any = false;
  for (const { key, label } of RESOURCE_ORDER) {
    const qty = Number((safe as any)[key] ?? 0);
    const price = prices[key];
    if (!qty || qty <= 0 || !Number.isFinite(price)) continue;

    const value = qty * (price as number);

    const qtyStr =
      key === "money"
        ? `$${Math.round(qty).toLocaleString("en-US")}`
        : qty.toLocaleString("en-US");

    const priceStr =
      key === "money"
        ? "$1"
        : `$${Number(price).toLocaleString("en-US", {
            maximumFractionDigits: 0,
          })}`;

    const valueStr = fmtMoney(value);

    lines.push(`**${label}** — ${qtyStr} × ${priceStr} = **${valueStr}**`);
    any = true;
  }

  if (!any) {
    lines.push("_No positive balances to value._");
  }

  // Total
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
      // credits: Number((safe as any).credits ?? 0), // enable if present
    },
    prices
  );

  const embed = new EmbedBuilder()
    .setTitle(`Market Value — ${member.discordHandle ?? targetUser.username}`)
    .setDescription(lines.join("\n"))
    .addFields({
      name: "Total Market Value",
      value: `**${fmtMoney(total)}**`,
      inline: false,
    })
    .setFooter({
      text: `Prices: PnW average tradeprice • As of ${new Date(asOf).toLocaleString()}`,
    })
    .setTimestamp(new Date());

  await i.editReply({ embeds: [embed] });
}
