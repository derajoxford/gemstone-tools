// src/commands/offshore.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  type Interaction,
  type CacheType,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

import {
  fetchAveragePrices,
  computeTotalValue,
  fmtMoney,
  type Resource,
  type PriceMap,
} from "../lib/market.js";

// Ledger helpers
import { catchUpLedgerForPair, readHeldBalances } from "../lib/offshore_ledger.js";

// local crypto (for alliance keys)
import * as cryptoMod from "../lib/crypto.js";
const open = (cryptoMod as any).open as (cipher: Uint8Array, nonce: Uint8Array) => string;

// Tag we embed into notes so our ledger scanner can trust transactions
const OFFSH_NOTE_TAG = "Gemstone Offsh";

// Node 20+: global fetch
const httpFetch: typeof fetch = (globalThis as any).fetch;

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
];

async function resolveAllianceAndOffshore(i: ChatInputCommandInteraction) {
  const guildLink = await prisma.allianceGuild.findFirst({
    where: { guildId: i.guildId! },
    include: { alliance: true },
  });
  if (!guildLink?.alliance) {
    throw new Error("This server isn’t linked to an alliance. Use /guild_link_alliance first.");
  }
  const alliance = guildLink.alliance;

  let offshoreAid: number | null = alliance.offshoreOverrideAllianceId ?? null;
  if (!offshoreAid) {
    const s = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
    const v = (s?.value as any) || null;
    if (v && typeof v.aid === "number") offshoreAid = v.aid;
  }
  if (!offshoreAid) throw new Error("No offshore alliance configured.");

  return { alliance, offshoreAid };
}

async function decryptLatestKeys(aid: number): Promise<{ apiKey?: string; botKey?: string }> {
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId: aid },
    orderBy: { id: "desc" },
  });
  if (!k) return {};
  const out: { apiKey?: string; botKey?: string } = {};
  try {
    if (k.encryptedApiKey && k.nonceApi) out.apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
  } catch {}
  try {
    if (k.encryptedBotKey && k.nonceBot) out.botKey = open(k.encryptedBotKey as any, k.nonceBot as any);
  } catch {}
  return out;
}

async function bankWithdraw({
  sourceAidApiKey,
  offshoreAidApiKey,
  botKey,
  receiverAid,
  payload, // { money?: number, ...; note?: string }
}: {
  sourceAidApiKey: string;
  offshoreAidApiKey: string;
  botKey: string;
  receiverAid: number;
  payload: { [k in Resource]?: number } & { note?: string };
}) {
  const url =
    (process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql") +
    "?api_key=" +
    encodeURIComponent(sourceAidApiKey);

  const fields: string[] = [];
  for (const k of Object.keys(payload)) {
    if (k === "note") continue;
    const v = (payload as any)[k];
    if (typeof v === "number" && v > 0) fields.push(`${k}:${v}`);
  }
  const note = payload.note ? `, note: ${JSON.stringify(payload.note)}` : "";
  const args = `receiver:${receiverAid}, receiver_type:2${fields.length ? ", " + fields.join(", ") : ""}${note}`;

  const body = { query: `mutation { bankWithdraw(${args}) { id } }` };

  const resp = await httpFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Api-Key": offshoreAidApiKey,
      "X-Bot-Key": botKey,
    },
    body: JSON.stringify(body),
  });
  const j = (await resp.json().catch(() => ({}))) as any;
  if (j?.errors?.length) {
    throw new Error(j.errors[0]?.message || "PnW error");
  }
  return j?.data?.bankWithdraw?.id as string | undefined;
}

export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Send funds to the configured offshore and/or view current offshore holdings.")
  .addSubcommand((s) => s.setName("send").setDescription("Open a form to send funds to the offshore."))
  .addSubcommand((s) => s.setName("show").setDescription("Show your alliance’s holdings in the offshore."));

export async function execute(i: ChatInputCommandInteraction) {
  try {
    if (i.options.getSubcommand() === "send") {
      const modal = new ModalBuilder().setCustomId("offsh_send_modal").setTitle("Send to Offshore");
      const amount = new TextInputBuilder()
        .setCustomId("money")
        .setLabel("Money (leave blank for 0)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
      const note = new TextInputBuilder()
        .setCustomId("note")
        .setLabel("Note (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
      const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(amount);
      const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(note);
      modal.addComponents(row1, row2);
      await i.showModal(modal);
      return;
    }

    // show
    await i.deferReply({ ephemeral: true });

    const { alliance, offshoreAid } = await resolveAllianceAndOffshore(i);

    // background refresh (non-blocking)
    catchUpLedgerForPair(prisma, alliance.id, offshoreAid).catch((e) =>
      console.warn("[OFFSH_LEDGER_BG_ERR]", e?.message || e)
    );

    const held = await readHeldBalances(prisma, alliance.id, offshoreAid);

    const pricing = await fetchAveragePrices();
    const prices = pricing?.prices || ({} as PriceMap);
    const asOf = pricing?.asOf ?? Date.now();
    const priceSource = pricing?.source ?? "REST avg";

    const get = (k: Resource) => Number((held as any)[k] ?? 0);
    const val: Record<Resource, number> = {
      money: get("money"),
      food: get("food"),
      coal: get("coal"),
      oil: get("oil"),
      uranium: get("uranium"),
      lead: get("lead"),
      iron: get("iron"),
      bauxite: get("bauxite"),
      gasoline: get("gasoline"),
      munitions: get("munitions"),
      steel: get("steel"),
      aluminum: get("aluminum"),
      credits: 0,
    };

    const fields: { name: string; value: string; inline: boolean }[] = [];
    let any = false;

    const priceOf = (r: Resource) =>
      Number.isFinite(prices[r] as number) ? (prices[r] as number) : undefined;

    for (const { key, label } of ORDER) {
      const qty = val[key];
      if (!qty || qty <= 0) continue;
      const qtyStr =
        key === "money" ? `$${Math.round(qty).toLocaleString("en-US")}` : qty.toLocaleString("en-US");
      const p = priceOf(key);
      if (p === undefined) {
        fields.push({ name: `${E[key]} ${label}`, value: `*price unavailable*\n${qtyStr}`, inline: true });
        any = true;
        continue;
      }
      const priceStr = key === "money" ? "$1" : `$${Math.round(p).toLocaleString("en-US")}`;
      const valueStr = fmtMoney(qty * (key === "money" ? 1 : p));
      fields.push({ name: `${E[key]} ${label}`, value: `**${valueStr}**\n${qtyStr} × ${priceStr}`, inline: true });
      any = true;
    }

    if (!any && val.money > 0) {
      fields.push({
        name: `${E.money} Money`,
        value: `**${fmtMoney(val.money)}**\n$${Math.round(val.money).toLocaleString("en-US")} × $1`,
        inline: true,
      });
    }

    const total = computeTotalValue(
      {
        money: val.money,
        food: val.food,
        coal: val.coal,
        oil: val.oil,
        uranium: val.uranium,
        lead: val.lead,
        iron: val.iron,
        bauxite: val.bauxite,
        gasoline: val.gasoline,
        munitions: val.munitions,
        steel: val.steel,
        aluminum: val.aluminum,
      },
      prices
    );

    const embed = new EmbedBuilder()
      .setTitle(`📊 Offshore Holdings — ${alliance.name || alliance.id}`)
      .setDescription(
        `${alliance.id} held in offshore ${offshoreAid}\nRunning balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”)`
      )
      .addFields(
        ...fields,
        { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
      )
      .setFooter({ text: `Prices: ${priceSource} • As of ${new Date(asOf).toLocaleString()}` });

    const btnRefresh = new ButtonBuilder()
      .setCustomId("offsh_holdings_refresh")
      .setLabel("Refresh Now")
      .setStyle(ButtonStyle.Secondary);

    const btnSend = new ButtonBuilder()
      .setCustomId("offsh_send_open")
      .setLabel("Send to Offshore")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(btnRefresh, btnSend);
    await i.editReply({ embeds: [embed], components: [row] });
  } catch (err: any) {
    const msg = err?.message || "Couldn’t compute holdings right now. Try again shortly.";
    try {
      await i.reply({ content: msg, ephemeral: true });
    } catch {
      try {
        await i.editReply({ content: msg });
      } catch {}
    }
  }
}

export async function handleButton(i: Interaction<CacheType>) {
  if (!i.isButton()) return;

  if (i.customId === "offsh_send_open") {
    const modal = new ModalBuilder().setCustomId("offsh_send_modal").setTitle("Send to Offshore");
    const amount = new TextInputBuilder()
      .setCustomId("money")
      .setLabel("Money (leave blank for 0)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    const note = new TextInputBuilder()
      .setCustomId("note")
      .setLabel("Note (optional)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(amount);
    const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(note);
    modal.addComponents(row1, row2);
    await i.showModal(modal);
    return;
  }

  if (i.customId === "offsh_holdings_refresh") {
    await i.deferUpdate();
    try {
      const guildLink = await prisma.allianceGuild.findFirst({
        where: { guildId: i.guildId! },
        include: { alliance: true },
      });
      if (!guildLink?.alliance) throw new Error("Server not linked to an alliance.");
      const alliance = guildLink.alliance;

      let offshoreAid: number | null = alliance.offshoreOverrideAllianceId ?? null;
      if (!offshoreAid) {
        const s = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
        const v = (s?.value as any) || null;
        if (v && typeof v.aid === "number") offshoreAid = v.aid;
      }
      if (!offshoreAid) throw new Error("No offshore alliance configured.");

      await catchUpLedgerForPair(prisma, alliance.id, offshoreAid);
      const held = await readHeldBalances(prisma, alliance.id, offshoreAid);

      const pricing = await fetchAveragePrices();
      const prices = pricing?.prices || ({} as PriceMap);
      const asOf = pricing?.asOf ?? Date.now();
      const priceSource = pricing?.source ?? "REST avg";

      const get = (k: Resource) => Number((held as any)[k] ?? 0);
      const val = {
        money: get("money"),
        food: get("food"),
        coal: get("coal"),
        oil: get("oil"),
        uranium: get("uranium"),
        lead: get("lead"),
        iron: get("iron"),
        bauxite: get("bauxite"),
        gasoline: get("gasoline"),
        munitions: get("munitions"),
        steel: get("steel"),
        aluminum: get("aluminum"),
      };

      const fields: { name: string; value: string; inline: boolean }[] = [];
      const priceOf = (r: Resource) =>
        Number.isFinite(prices[r] as number) ? (prices[r] as number) : undefined;

      for (const { key, label } of ORDER) {
        const qty = (val as any)[key] as number;
        if (!qty || qty <= 0) continue;
        const qtyStr = key === "money" ? `$${Math.round(qty).toLocaleString("en-US")}` : qty.toLocaleString("en-US");
        const p = priceOf(key);
        if (p === undefined) {
          fields.push({ name: `${E[key]} ${label}`, value: `*price unavailable*\n${qtyStr}`, inline: true });
          continue;
        }
        const priceStr = key === "money" ? "$1" : `$${Math.round(p).toLocaleString("en-US")}`;
        const valueStr = fmtMoney(qty * (key === "money" ? 1 : p));
        fields.push({ name: `${E[key]} ${label}`, value: `**${valueStr}**\n${qtyStr} × ${priceStr}`, inline: true });
      }

      const total = computeTotalValue(val as any, prices);
      const embed = new EmbedBuilder()
        .setTitle(`📊 Offshore Holdings — ${alliance.name || alliance.id}`)
        .setDescription(
          `${alliance.id} held in offshore ${offshoreAid}\nRunning balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”)`
        )
        .addFields(
          ...fields,
          { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
        )
        .setFooter({ text: `Prices: ${priceSource} • As of ${new Date(asOf).toLocaleString()}` });

      await i.editReply({ embeds: [embed] });
    } catch (e: any) {
      await i.editReply({ content: e?.message || "Refresh failed. Try again shortly." });
    }
  }
}

export async function handleModal(i: Interaction<CacheType>) {
  if (!i.isModalSubmit()) return;
  if (i.customId !== "offsh_send_modal") return;

  await i.deferReply({ ephemeral: true });

  try {
    const guildLink = await prisma.allianceGuild.findFirst({
      where: { guildId: i.guildId! },
      include: { alliance: true },
    });
    if (!guildLink?.alliance) throw new Error("Server not linked to an alliance.");
    const alliance = guildLink.alliance;

    let offshoreAid: number | null = alliance.offshoreOverrideAllianceId ?? null;
    if (!offshoreAid) {
      const s = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
      const v = (s?.value as any) || null;
      if (v && typeof v.aid === "number") offshoreAid = v.aid;
    }
    if (!offshoreAid) throw new Error("No offshore alliance configured.");

    const srcKeys = await decryptLatestKeys(alliance.id);
    const offKeys = await decryptLatestKeys(offshoreAid);

    if (!srcKeys.apiKey) throw new Error("No API key saved for your alliance.");
    if (!offKeys.apiKey) throw new Error("No API key saved for the offshore alliance.");
    if (!offKeys.botKey) throw new Error("No bot (mutations) key saved for the offshore alliance.");

    const moneyStr = i.fields.getTextInputValue("money")?.trim() || "";
    const noteStr = i.fields.getTextInputValue("note")?.trim() || "";

    const money = moneyStr ? Math.max(0, Number(moneyStr)) : 0;
    const note = `${OFFSH_NOTE_TAG} • src ${alliance.id} -> off ${offshoreAid}${noteStr ? ` • ${noteStr}` : ""}`;

    const id = await bankWithdraw({
      sourceAidApiKey: srcKeys.apiKey!,
      offshoreAidApiKey: offKeys.apiKey!,
      botKey: offKeys.botKey!,
      receiverAid: offshoreAid,
      payload: { money, note },
    });

    await i.editReply(
      id
        ? `✅ Sent request **#${id}** — ${money ? `$${money.toLocaleString("en-US")}` : "no funds"} to ${offshoreAid}.`
        : "✅ Request accepted (no id returned)."
    );
  } catch (err: any) {
    await i.editReply(`❌ Send failed: ${err?.message || "Unknown error"}`);
  }
}
