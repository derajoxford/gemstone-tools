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
  ButtonInteraction,
  ModalSubmitInteraction,
  ComponentType,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import fetch from "node-fetch";

import {
  fetchAveragePrices,
  computeTotalValue,
  fmtMoney,
  Resource,
  PriceMap,
} from "../lib/market.js";

import { catchUpLedgerForPair, readHeldBalances } from "../lib/offshore_ledger";

const prisma = new PrismaClient();

// Tag that marks bot-origin offshore transfers in the PnW note
const OFFSH_NOTE_TAG = "Gemstone Offsh";

// ---------- pretty bits (mirrors /market_value) ----------
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

// ---------- ids ----------
const BTN_SEND_OPEN = "offsh:send_open";
const BTN_SHOW = "offsh:show";
const MODAL_SEND = "offsh:send_modal";

// ---------- utils ----------
async function resolveAllianceIdForGuild(guildId: string): Promise<number | null> {
  const ag = await prisma.allianceGuild.findFirst({ where: { guildId } });
  return ag?.allianceId ?? null;
}

async function getAllianceName(aid: number): Promise<string> {
  const a = await prisma.alliance.findUnique({ where: { id: aid } });
  return a?.name || String(aid);
}

async function getDefaultOffshoreIdForAlliance(aid: number): Promise<number | null> {
  // 1) explicit override on the alliance row
  const a = await prisma.alliance.findUnique({ where: { id: aid } });
  if (a?.offshoreOverrideAllianceId) return a.offshoreOverrideAllianceId;

  // 2) global default in settings: key = 'default_offshore_aid', value = {"aid": 14258}
  const s = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
  const val = (s?.value as any) || null;
  if (val && typeof val.aid === "number") return val.aid;

  return null;
}

type AmountPayload = Partial<Record<Resource, number>>;

function parsePositiveNumber(s: string | null): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/[, ]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function buildRootEmbed(allianceName: string, offshoreName: string) {
  return new EmbedBuilder()
    .setTitle("Alliance Offshore")
    .setDescription(
      [
        `**Main Alliance:** ${allianceName}`,
        `**Offshore:** ${offshoreName}`,
        "",
        "Use the buttons below to send resources to the offshore or view held balances.",
      ].join("\n")
    );
}

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Alliance offshoring: move funds to a designated offshore + show holdings.");

// Shows the root panel with buttons
export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const guildId = i.guildId!;
  const allianceId = await resolveAllianceIdForGuild(guildId);
  if (!allianceId) {
    await i.editReply(
      "This server is not linked to an alliance. Use `/guild_link_alliance` or `/setup_alliance` first."
    );
    return;
  }

  const offshoreAid = await getDefaultOffshoreIdForAlliance(allianceId);
  if (!offshoreAid) {
    await i.editReply(
      "No offshore is configured yet. Set a default offshore in Settings or on the Alliance row."
    );
    return;
  }

  const [aName, offName] = await Promise.all([
    getAllianceName(allianceId),
    getAllianceName(offshoreAid),
  ]);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(BTN_SEND_OPEN).setStyle(ButtonStyle.Primary).setLabel("Send to Offshore"),
    new ButtonBuilder().setCustomId(BTN_SHOW).setStyle(ButtonStyle.Secondary).setLabel("Show Holdings")
  );

  const embed = buildRootEmbed(aName, offName);
  await i.editReply({ embeds: [embed], components: [row] });
}

// ---------- buttons / modal ----------
export async function handleButton(bi: ButtonInteraction) {
  try {
    if (bi.customId === BTN_SEND_OPEN) {
      // open modal
      const modal = new ModalBuilder().setCustomId(MODAL_SEND).setTitle("Send to Offshore");

      const note = new TextInputBuilder()
        .setCustomId("note")
        .setLabel("Note (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("e.g., project X. Tag is auto-added");

      const money = new TextInputBuilder()
        .setCustomId("money")
        .setLabel("Money ($ whole number)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const resRow1 = new ActionRowBuilder<TextInputBuilder>().addComponents(money);
      const noteRow = new ActionRowBuilder<TextInputBuilder>().addComponents(note);

      // Optional resources (same ids as market)
      const resIds: Array<{ id: Resource; label: string }> = [
        { id: "food", label: "Food" },
        { id: "coal", label: "Coal" },
        { id: "oil", label: "Oil" },
        { id: "uranium", label: "Uranium" },
        { id: "lead", label: "Lead" },
        { id: "iron", label: "Iron" },
        { id: "bauxite", label: "Bauxite" },
        { id: "gasoline", label: "Gasoline" },
        { id: "munitions", label: "Munitions" },
        { id: "steel", label: "Steel" },
        { id: "aluminum", label: "Aluminum" },
      ];

      // We’ll include a few common fields to keep Discord modal within limits
      const optRows: ActionRowBuilder<TextInputBuilder>[] = [];
      for (const r of resIds) {
        const ti = new TextInputBuilder()
          .setCustomId(r.id)
          .setLabel(`${r.label} (qty)`)
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        optRows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(ti));
      }

      modal.addComponents(resRow1, ...optRows.slice(0, 5), noteRow); // keep modal size sane
      await bi.showModal(modal);
      return;
    }

    if (bi.customId === BTN_SHOW) {
      await bi.deferReply({ ephemeral: true });

      const guildId = bi.guildId!;
      const allianceId = await resolveAllianceIdForGuild(guildId);
      if (!allianceId) {
        await bi.editReply("This server isn’t linked to an alliance.");
        return;
      }

      const offshoreAid = await getDefaultOffshoreIdForAlliance(allianceId);
      if (!offshoreAid) {
        await bi.editReply("No offshore configured yet.");
        return;
      }

      // Fast: update ledger in the background (no await needed for response speed)
      catchUpLedgerForPair(prisma, allianceId, offshoreAid).catch(() => {});

      // Read running held balances (already netted A→Off minus Off→A, tag-filtered)
      const held = await readHeldBalances(prisma, allianceId, offshoreAid);

      // Pricing
      const pricing = await fetchAveragePrices(); // { prices, asOf, source }
      if (!pricing) {
        await bi.editReply("Couldn’t get market prices. Try again later.");
        return;
      }
      const { prices, asOf, source } = pricing;

      // Build pretty embed
      const fields: { name: string; value: string; inline: boolean }[] = [];
      const getPrice = (res: Resource, pmap: PriceMap) =>
        Number.isFinite(pmap[res] as number) ? (pmap[res] as number) : undefined;

      let any = false;
      for (const { key, label } of ORDER) {
        const qty = Number((held as any)[key] ?? 0);
        if (!qty || qty <= 0) continue;

        const price = getPrice(key, prices);
        const qtyStr =
          key === "money"
            ? `$${Math.round(qty).toLocaleString("en-US")}`
            : qty.toLocaleString("en-US");

        if (price === undefined) {
          fields.push({
            name: `${E[key]} ${label}`,
            value: `*price unavailable*\n${qtyStr}`,
            inline: true,
          });
          any = true;
          continue;
        }

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
        any = true;
      }

      if (!any) {
        fields.push({ name: "No Holdings", value: "Nothing held in the offshore yet.", inline: false });
      }

      const total = computeTotalValue(
        {
          money: Number((held as any).money ?? 0),
          food: Number((held as any).food ?? 0),
          coal: Number((held as any).coal ?? 0),
          oil: Number((held as any).oil ?? 0),
          uranium: Number((held as any).uranium ?? 0),
          lead: Number((held as any).lead ?? 0),
          iron: Number((held as any).iron ?? 0),
          bauxite: Number((held as any).bauxite ?? 0),
          gasoline: Number((held as any).gasoline ?? 0),
          munitions: Number((held as any).munitions ?? 0),
          steel: Number((held as any).steel ?? 0),
          aluminum: Number((held as any).aluminum ?? 0),
        },
        prices
      );

      const [aName, offName] = await Promise.all([
        getAllianceName(allianceId),
        getAllianceName(offshoreAid),
      ]);

      const embed = new EmbedBuilder()
        .setTitle(`📊 Offshore Holdings — ${aName}`)
        .setDescription(`${aName} held in offshore **${offName}**\nRunning balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”)`)
        .addFields(
          ...fields,
          { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
        )
        .setFooter({
          text: `Prices: ${source} • As of ${new Date(asOf).toLocaleString()}`,
        });

      await bi.editReply({ embeds: [embed], components: [] });
      return;
    }
  } catch (err) {
    try {
      await bi.reply({ content: "Sorry, something went wrong.", ephemeral: true });
    } catch {}
  }
}

export async function handleModal(mi: ModalSubmitInteraction) {
  if (mi.customId !== MODAL_SEND) return;

  try {
    await mi.deferReply({ ephemeral: true });

    const guildId = mi.guildId!;
    const allianceId = await resolveAllianceIdForGuild(guildId);
    if (!allianceId) {
      await mi.editReply("This server isn’t linked to an alliance.");
      return;
    }

    const offshoreAid = await getDefaultOffshoreIdForAlliance(allianceId);
    if (!offshoreAid) {
      await mi.editReply("No offshore configured yet.");
      return;
    }

    // Collect amounts
    const payload: AmountPayload = {};
    const money = parsePositiveNumber(mi.fields.getTextInputValue("money") || "");
    if (money) payload.money = money;

    const opt: Resource[] = [
      "food",
      "coal",
      "oil",
      "uranium",
      "lead",
      "iron",
      "bauxite",
      "gasoline",
      "munitions",
      "steel",
      "aluminum",
    ];
    for (const r of opt) {
      const v = parsePositiveNumber(mi.fields.getTextInputValue(r) || "");
      if (v) payload[r] = v;
    }

    if (Object.keys(payload).length === 0) {
      await mi.editReply("Nothing to send. Enter at least one positive amount.");
      return;
    }

    // Compose note (tag is always included)
    const userNote = (mi.fields.getTextInputValue("note") || "").trim();
    const note = userNote
      ? `${OFFSH_NOTE_TAG} • ${userNote}`
      : OFFSH_NOTE_TAG;

    // Find the newest AllianceKey row for the **source alliance** (API + Bot)
    const a = await prisma.alliance.findUnique({
      where: { id: allianceId },
      include: { keys: { orderBy: { id: "desc" } } },
    });
    if (!a || !a.keys.length) {
      await mi.editReply("No saved Alliance API/Bot keys for this alliance. Use `/setup_alliance`.");
      return;
    }

    // Decrypt keys using your crypto util (matches your existing send path)
    // We assume src/lib/crypto.js exports: open(ciphertext: string|Buffer, nonce: string|Buffer): string
    const cryptoMod = await import("../lib/crypto.js" as any);
    const open = (cryptoMod as any).open as (cipher: any, nonce: any) => string;

    const k = a.keys[0];
    let apiKey = "";
    let botKey = "";

    try {
      apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
      if (k.encryptedBotKey && k.nonceBot) {
        botKey = open(k.encryptedBotKey as any, k.nonceBot as any);
      }
    } catch (e) {
      await mi.editReply("Failed to decrypt the stored keys. Re-run `/setup_alliance`.");
      return;
    }

    if (!apiKey) {
      await mi.editReply("Alliance API key missing. Re-run `/setup_alliance`.");
      return;
    }
    if (!botKey) {
      await mi.editReply("Alliance bot key (mutations) missing. Re-run `/setup_alliance`.");
      return;
    }

    // Build GraphQL mutation with only provided fields
    const parts: string[] = [`receiver: ${offshoreAid}`, `receiver_type: 2`];
    if (payload.money) parts.push(`money: ${Math.floor(payload.money)}`);
    if (payload.food) parts.push(`food: ${payload.food}`);
    if (payload.coal) parts.push(`coal: ${payload.coal}`);
    if (payload.oil) parts.push(`oil: ${payload.oil}`);
    if (payload.uranium) parts.push(`uranium: ${payload.uranium}`);
    if (payload.lead) parts.push(`lead: ${payload.lead}`);
    if (payload.iron) parts.push(`iron: ${payload.iron}`);
    if (payload.bauxite) parts.push(`bauxite: ${payload.bauxite}`);
    if (payload.gasoline) parts.push(`gasoline: ${payload.gasoline}`);
    if (payload.munitions) parts.push(`munitions: ${payload.munitions}`);
    if (payload.steel) parts.push(`steel: ${payload.steel}`);
    if (payload.aluminum) parts.push(`aluminum: ${payload.aluminum}`);
    parts.push(`note: ${JSON.stringify(note)}`);

    const gql = `mutation { bankWithdraw(${parts.join(", ")}) { id } }`;

    const url =
      (process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql") +
      `?api_key=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Api-Key": apiKey,
        "X-Bot-Key": botKey,
      },
      body: JSON.stringify({ query: gql }),
    });

    const j = (await resp.json().catch(() => ({}))) as any;

    if (j?.errors?.length) {
      const msg = j.errors[0]?.message || "Unknown error";
      await mi.editReply(`❌ Send failed: ${msg}`);
      return;
    }

    const txid = j?.data?.bankWithdraw?.id;
    if (!txid) {
      await mi.editReply("Send completed, but no transaction id was returned.");
      return;
    }

    // Update ledger in background for snappier UX
    catchUpLedgerForPair(prisma, allianceId, offshoreAid).catch(() => {});

    await mi.editReply(`✅ Sent to offshore (tx **${txid}**).`);
  } catch (err) {
    try {
      await mi.editReply("Sorry, something went wrong while sending.");
    } catch {}
  }
}

// ---------- component router helper (optional) ----------
export function wants(i: { componentType?: ComponentType; customId?: string }) {
  if (!i.customId) return false;
  return i.customId.startsWith("offsh:");
}
