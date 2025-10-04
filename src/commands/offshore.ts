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

// Price + formatting utils (shared with /market_value)
import {
  fetchAveragePrices,
  computeTotalValue,
  fmtMoney,
  type Resource,
  type PriceMap,
} from "../lib/market.js";

// Ledger helpers (no OFFSH_NOTE_TAG/readLedger import here)
import { catchUpLedgerForPair, readHeldBalances } from "../lib/offshore_ledger.js";

// Local decrypt
import * as cryptoMod from "../lib/crypto.js";
const open = (cryptoMod as any).open as (cipher: Uint8Array, nonce: Uint8Array) => string;

// We keep the send note tag local so we don't depend on an export
const OFFSH_NOTE_TAG = "Gemstone Offsh";

// Node 20+ has global fetch. We alias to make types happy.
const httpFetch: typeof fetch = (globalThis as any).fetch;

const prisma = new PrismaClient();

/** Discord resource icon map (same style as /market_value) */
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

/** Resolve the alliance for the current guild, and any offshore override/default */
async function resolveAllianceAndOffshore(i: ChatInputCommandInteraction) {
  // Alliance linked to this guild
  const guildLink = await prisma.allianceGuild.findFirst({
    where: { guildId: i.guildId! },
    include: { alliance: true },
  });

  if (!guildLink?.alliance) {
    throw new Error("This server is not linked to an alliance. Use /guild_link_alliance first.");
  }

  const alliance = guildLink.alliance;

  // Offshore target:
  // 1) explicit override on alliance.offshoreOverrideAllianceId
  // 2) Setting(key="default_offshore_aid").value = { aid: number }
  let offshoreAid: number | null = null;
  if (alliance.offshoreOverrideAllianceId) {
    offshoreAid = alliance.offshoreOverrideAllianceId;
  } else {
    const setting = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
    const val = setting?.value as any;
    if (val && typeof val.aid === "number") offshoreAid = val.aid;
  }

  if (!offshoreAid) {
    throw new Error(
      "No offshore alliance configured. Set an override on the alliance or a Setting default_offshore_aid."
    );
  }

  return { alliance, offshoreAid };
}

/** Decrypt most recent API/Bot keys for an alliance */
async function decryptLatestKeys(aid: number): Promise<{ apiKey?: string; botKey?: string }> {
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId: aid },
    orderBy: { id: "desc" },
  });
  if (!k) return {};
  let apiKey: string | undefined;
  let botKey: string | undefined;

  try {
    if (k.encryptedApiKey && k.nonceApi) {
      apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
    }
  } catch {
    /* ignore */
  }
  try {
    if (k.encryptedBotKey && k.nonceBot) {
      botKey = open(k.encryptedBotKey as any, k.nonceBot as any);
    }
  } catch {
    /* ignore */
  }
  return { apiKey, botKey };
}

/** Perform the PnW bankWithdraw mutation (amounts can be zero for probe) */
async function bankWithdraw({
  sourceAidApiKey, // SOURCE alliance API key goes in the query param
  offshoreAidApiKey, // OFFSHORE alliance API key goes in X-Api-Key header
  botKey,
  receiverAid,
  payload, // e.g. { money: 1, note: "..." }
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
    if (typeof v === "number" && v > 0) {
      fields.push(`${k}:${v}`);
    }
  }
  const note = payload.note ? `, note: ${JSON.stringify(payload.note)}` : "";
  const args = `receiver:${receiverAid}, receiver_type:2${fields.length ? ", " + fields.join(", ") : ""
    }${note}`;

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
    const msg = j.errors[0]?.message || "Unknown PnW error";
    throw new Error(msg);
  }
  return j?.data?.bankWithdraw?.id as string | undefined;
}

export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Move funds to the configured offshore and/or view current offshore holdings.")
  .addSubcommand((s) =>
    s
      .setName("send")
      .setDescription("Open a form to send money/resources to your configured offshore.")
  )
  .addSubcommand((s) =>
    s.setName("show").setDescription("Show your alliance’s holdings currently in the offshore.")
  );

export async function execute(i: ChatInputCommandInteraction) {
  try {
    if (i.options.getSubcommand() === "send") {
      // Open modal
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

    // Quick background catch-up (non-blocking)
    // If you ever want a blocking refresh, call and await this instead.
    catchUpLedgerForPair(prisma, alliance.id, offshoreAid).catch((e) =>
      console.warn("[OFFSH_LEDGER_BG_ERR]", e?.message || e)
    );

    // Read the fast, running balance from ledger
    const held = await readHeldBalances(prisma, alliance.id, offshoreAid);

    // Prices
    const pricing = await fetchAveragePrices();
    const prices = pricing?.prices || ({} as PriceMap);
    const asOf = pricing?.asOf ?? Date.now();
    const priceSource = pricing?.source ?? "REST avg";

    const fields: { name: string; value: string; inline: boolean }[] = [];
    let anyShown = false;

    const qtyOf = (k: Resource) => Number((held as any)[k] ?? 0);
    const getPrice = (res: Resource, pmap: PriceMap) =>
      Number.isFinite(pmap[res] as number) ? (pmap[res] as number) : undefined;

    for (const { key, label } of ORDER) {
      const qty = qtyOf(key);
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
        anyShown = true;
        continue;
      }

      const priceStr =
        key === "money"
          ? "$1"
          : `$${Number(price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      const valueStr = fmtMoney(qty * (key === "money" ? 1 : price));

      fields.push({
        name: `${E[key]} ${label}`,
        value: `**${valueStr}**\n${qtyStr} × ${priceStr}`,
        inline: true,
      });
      anyShown = true;
    }

    // If nothing except possibly $ exists, still show money if present
    if (!anyShown && qtyOf("money") > 0) {
      const m = qtyOf("money");
      fields.push({
        name: `${E.money} Money`,
        value: `**${fmtMoney(m)}**\n$${Math.round(m).toLocaleString("en-US")} × $1`,
        inline: true,
      });
    }

    const total = computeTotalValue(
      {
        money: qtyOf("money"),
        food: qtyOf("food"),
        coal: qtyOf("coal"),
        oil: qtyOf("oil"),
        uranium: qtyOf("uranium"),
        lead: qtyOf("lead"),
        iron: qtyOf("iron"),
        bauxite: qtyOf("bauxite"),
        gasoline: qtyOf("gasoline"),
        munitions: qtyOf("munitions"),
        steel: qtyOf("steel"),
        aluminum: qtyOf("aluminum"),
      },
      prices
    );

    const callingAllianceName = alliance.name || String(alliance.id);

    const embed = new EmbedBuilder()
      .setTitle(`📊 Offshore Holdings — ${callingAllianceName}`)
      .setDescription(
        `${alliance.id} held in offshore ${offshoreAid}\nRunning balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”)`
      )
      .addFields(
        ...fields,
        { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
      )
      .setFooter({
        text: `Prices: ${priceSource} • As of ${new Date(asOf).toLocaleString()}`,
      });

    // Buttons: Refresh (blocking) and Send
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
    const msg =
      err?.message ||
      "Couldn’t compute holdings right now. Try again in a moment.";
    try {
      await i.reply({ content: msg, ephemeral: true });
    } catch {
      try {
        await i.editReply({ content: msg });
      } catch {}
    }
  }
}

/** Button + Modal handlers */
export async function handleButton(i: Interaction<CacheType>) {
  if (!i.isButton()) return;

  if (i.customId === "offsh_send_open") {
    // Same modal as /offshore send
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
      const cmdCtx = {
        guildId: i.guildId!,
        user: i.user,
      } as any;

      // Inline resolve (minimal duplication)
      const guildLink = await prisma.allianceGuild.findFirst({
        where: { guildId: i.guildId! },
        include: { alliance: true },
      });
      if (!guildLink?.alliance) throw new Error("Server not linked to an alliance.");
      const alliance = guildLink.alliance;

      let offshoreAid: number | null = alliance.offshoreOverrideAllianceId ?? null;
      if (!offshoreAid) {
        const setting = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
        const val = setting?.value as any;
        if (val && typeof val.aid === "number") offshoreAid = val.aid;
      }
      if (!offshoreAid) throw new Error("No offshore alliance configured.");

      // Blocking refresh
      await catchUpLedgerForPair(prisma, alliance.id, offshoreAid);

      // Recompute embed
      const held = await readHeldBalances(prisma, alliance.id, offshoreAid);
      const pricing = await fetchAveragePrices();
      const prices = pricing?.prices || ({} as PriceMap);
      const asOf = pricing?.asOf ?? Date.now();
      const priceSource = pricing?.source ?? "REST avg";

      const fields: { name: string; value: string; inline: boolean }[] = [];
      const qtyOf = (k: Resource) => Number((held as any)[k] ?? 0);
      const getPrice = (res: Resource, pmap: PriceMap) =>
        Number.isFinite(pmap[res] as number) ? (pmap[res] as number) : undefined;

      for (const { key, label } of ORDER) {
        const qty = qtyOf(key);
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
          continue;
        }
        const priceStr =
          key === "money"
            ? "$1"
            : `$${Number(price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
        const valueStr = fmtMoney(qty * (key === "money" ? 1 : price));
        fields.push({
          name: `${E[key]} ${label}`,
          value: `**${valueStr}**\n${qtyStr} × ${priceStr}`,
          inline: true,
        });
      }

      const total = computeTotalValue(
        {
          money: qtyOf("money"),
          food: qtyOf("food"),
          coal: qtyOf("coal"),
          oil: qtyOf("oil"),
          uranium: qtyOf("uranium"),
          lead: qtyOf("lead"),
          iron: qtyOf("iron"),
          bauxite: qtyOf("bauxite"),
          gasoline: qtyOf("gasoline"),
          munitions: qtyOf("munitions"),
          steel: qtyOf("steel"),
          aluminum: qtyOf("aluminum"),
        },
        prices
      );

      const callingAllianceName = alliance.name || String(alliance.id);
      const embed = new EmbedBuilder()
        .setTitle(`📊 Offshore Holdings — ${callingAllianceName}`)
        .setDescription(
          `${alliance.id} held in offshore ${offshoreAid}\nRunning balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”)`
        )
        .addFields(
          ...fields,
          { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
        )
        .setFooter({
          text: `Prices: ${priceSource} • As of ${new Date(asOf).toLocaleString()}`,
        });

      await i.editReply({ embeds: [embed] });
    } catch (e: any) {
      await i.editReply({ content: e?.message || "Refresh failed. Try again shortly." });
    }
  }
}

/** Modal submit handler (send flow) */
export async function handleModal(i: Interaction<CacheType>) {
  if (!i.isModalSubmit()) return;
  if (i.customId !== "offsh_send_modal") return;

  await i.deferReply({ ephemeral: true });

  try {
    const { alliance, offshoreAid } = await resolveAllianceAndOffshore(i as any);

    // Decrypt keys: source alliance (calling) + offshore (receiver) + your bot key
    const srcKeys = await decryptLatestKeys(alliance.id);
    const offKeys = await decryptLatestKeys(offshoreAid);

    if (!srcKeys.apiKey) throw new Error("No API key saved for your alliance.");
    if (!offKeys.apiKey) throw new Error("No API key saved for the offshore alliance.");
    if (!offKeys.botKey) throw new Error("No bot (mutations) key saved for the offshore alliance.");

    const moneyStr = i.fields.getTextInputValue("money")?.trim() || "";
    const noteStr = i.fields.getTextInputValue("note")?.trim() || "";

    const money = moneyStr ? Math.max(0, Number(moneyStr)) : 0;

    const note =
      `${OFFSH_NOTE_TAG} • src ${alliance.id} -> off ${offshoreAid}` +
      (noteStr ? ` • ${noteStr}` : "");

    // Perform mutation (amount zero is allowed but pointless here)
    const id = await bankWithdraw({
      sourceAidApiKey: srcKeys.apiKey,
      offshoreAidApiKey: offKeys.apiKey,
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
