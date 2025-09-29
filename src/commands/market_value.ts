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

// Emojis for quick scanning
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

// Display order
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
  // { key: "credits", label: "Credits" }, // enable if you store credits
];

// Safekeep aliases → normalize to our Resource keys
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

// Pull numeric qty from safekeep object by alias list
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

// Collect all resource quantities from safekeep with alias support
function collectSafekeep(safe: any): Partial<Record<Resource, number>> {
  const out: Partial<Record<Resource, number>> = {};
  (Object.keys(SAFE_ALIASES) as Resource[]).forEach((res) => {
    const qty = readQty(safe, SAFE_ALIASES[res]);
    if (qty > 0) out[res] = qty;
  });
  // Always include money (even if 0) so totals still reflect cash
  if (out.money === undefined) out.money = readQty(safe, SAFE_ALIASES.money);
  return out;
}

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

  // Resolve Member + Safekeeping robustly
  let member =
    (await prisma.member.findFirst({ where: { discordId: targetUser.id } })) || null;

  let safe =
    member &&
    (await prisma.safekeeping.findFirst({ where: { memberId: member.id } }));

  if (!safe) {
    const viaSafe = await prisma.safekeeping.findFirst({
      where: { member: { discordId: targetUser.id } },
      include: { member: true },
    });
    if (viaSafe) {
      safe = viaSafe;
      member = viaSafe.member;
    }
  }

  if (!member) {
    await i.editReply(
      "No safekeeping account found for that member. If this is you, link your account first (e.g., `/link_nation`) or ask a banker to add you."
    );
    return;
  }

  if (!safe) {
    safe = await prisma.safekeeping.create({ data: { memberId: member.id } });
  }

  // Quantities (alias-aware)
  const qtys = collectSafekeep(safe);

  // Fetch prices (GraphQL → REST → money-only)
  const pricing = await fetchAveragePrices().catch(() => null);
  if (!pricing) {
    await i.editReply("Market data is unavailable right now. Please try again later.");
    return;
  }
  const { prices, asOf, source } = pricing;

  // Build fields — split into priced vs unpriced so we always show your holdings
  const fields: { name: string; value: string; inline: boolean }[] = [];
  const missing: string[] = [];
  let anyPriced = false;

  const getPrice = (res: Resource, pmap: PriceMap) =>
    Number.isFinite(pmap[res] as number) ? (pmap[res] as number) : undefined;

  for (const { key, label } of ORDER) {
    const qty = Number(qtys[key] ?? 0);
    if (!qty || qty <= 0) continue;

    const price = getPrice(key, prices);
    if (price === undefined) {
      // Show the resource even if price is unavailable
      const qtyStr =
        key === "money"
          ? `$${Math.round(qty).toLocaleString("en-US")}`
          : qty.toLocaleString("en-US");
      fields.push({
        name: `${E[key]} ${label}`,
        value: `*price unavailable*\n${qtyStr}`,
        inline: true,
      });
      if (key !== "money") missing.push(label);
      continue;
    }

    const qtyStr =
      key === "money"
        ? `$${Math.round(qty).toLocaleString("en-US")}`
        : qty.toLocaleString("en-US");
    const priceStr =
      key === "money"
        ? "$1"
        : `$${Number(price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    const valueStr = fmtMoney(qty * price);

    fields.push({
      name: `${E[key]} ${label}`,
      value: `**${valueStr}**\n${qtyStr} × ${priceStr}`,
      inline: true,
    });
    anyPriced = true;
  }

  if (!anyPriced && (qtys.money ?? 0) > 0) {
    // fall back to money line if literally nothing else priced
    const money = Number(qtys.money ?? 0);
    fields.push({
      name: `${E.money} Money`,
      value: `**${fmtMoney(money)}**\n$${Math.round(money).toLocaleString("en-US")} × $1`,
      inline: true,
    });
  }

  // Compute total using priced resources only
  const total = computeTotalValue(
    {
      money: Number(qtys.money ?? 0),
      food: Number(qtys.food ?? 0),
      coal: Number(qtys.coal ?? 0),
      oil: Number(qtys.oil ?? 0),
      uranium: Number(qtys.uranium ?? 0),
      lead: Number(qtys.lead ?? 0),
      iron: Number(qtys.iron ?? 0),
      bauxite: Number(qtys.bauxite ?? 0),
      gasoline: Number(qtys.gasoline ?? 0),
      munitions: Number(qtys.munitions ?? 0),
      steel: Number(qtys.steel ?? 0),
      aluminum: Number(qtys.aluminum ?? 0),
      // credits: Number(qtys.credits ?? 0),
    },
    prices
  );

  const footerBits = [`Source: ${source}`, `As of ${new Date(asOf).toLocaleString()}`];
  if (missing.length) footerBits.push(`No prices for: ${missing.join(", ")}`);

  const embed = new EmbedBuilder()
    .setTitle(`Market Value — ${member.nationName || targetUser.username}`)
    .addFields(
      ...fields,
      { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
    )
    .setFooter({ text: footerBits.join(" • ") });

  await i.editReply({ embeds: [embed] });
}
