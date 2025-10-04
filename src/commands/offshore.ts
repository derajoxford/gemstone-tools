// src/commands/offshore.ts
//
// Offshore controller: show / set default / set override / holdings / send (modal).
//
// ✅ Send auth model (do not change):
//   - URL  ?api_key=  → SENDER alliance key (main alliance)
//   - HEAD X-Api-Key  → OFFSHORE alliance saved key (actor header)
//   - HEAD X-Bot-Key  → mutations key (PNW_BOT_KEY)
//
// 📊 Holdings (leader view, fast):
//   - Uses a RUNNING LEDGER per (allianceId, offshoreId). We incrementally catch
//     up from lastSeenBankrecId using bot-tagged offshore bankrecs.
//   - Embed shows priced breakdown (same pricing lib as /market_value).
//
// Env: BOT_ADMIN_DISCORD_ID, PNW_BOT_KEY, PNW_GRAPHQL_URL (opt)

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Interaction,
  ButtonInteraction,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { RESOURCE_KEYS } from "../lib/pnw";
import { getDefaultOffshore, setDefaultOffshore } from "../lib/offshore";
import { open } from "../lib/crypto";

// NEW: ledger helpers
import { catchUpLedgerForPair, OFFSH_NOTE_TAG } from "../lib/offshore_ledger";

// pricing (same as /market_value)
import {
  fetchAveragePrices,
  computeTotalValue,
  fmtMoney,
  Resource,
  PriceMap,
} from "../lib/market.js";

const prisma = new PrismaClient();

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[, _]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
function nowIso() {
  return new Date().toISOString();
}
const GQL_URL = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";

// ---------- effective offshore ----------
async function resolveOffshoreAid(allianceId: number): Promise<{ global: number | null; override: number | null; effective: number | null }> {
  const global = await getDefaultOffshore();
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  const override = a?.offshoreOverrideAllianceId ?? null;
  return { global, override, effective: override ?? global ?? null };
}

// ---------- key selection & validation ----------
async function validateApiKeyForAlliance(apiKey: string, aid: number): Promise<boolean> {
  try {
    const body = { query: `{ alliances(first: 1, id: [${aid}]) { data { id } } }` };
    const url = new URL(GQL_URL);
    url.searchParams.set("api_key", apiKey);

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify(body),
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || Array.isArray(json?.errors)) {
      console.warn("OFFSH_KEY_VALIDATE_ERR", resp.status, JSON.stringify(json));
      return false;
    }
    return Boolean(json?.data?.alliances?.data?.length);
  } catch (e) {
    console.warn("OFFSH_KEY_VALIDATE_EXC", e);
    return false;
  }
}

async function getAllianceApiKeyFor(aid: number): Promise<string | null> {
  try {
    const alliance = await prisma.alliance.findUnique({
      where: { id: aid },
      include: { keys: { orderBy: { id: "desc" } } },
    });

    const keys = alliance?.keys || [];
    console.log("OFFSH_KEY_SCAN", JSON.stringify({ aid, totalKeys: keys.length, keyIds: keys.map((k) => k.id) }));

    for (const k of keys) {
      try {
        const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
        const ok = await validateApiKeyForAlliance(apiKey, aid);
        console.log("OFFSH_KEY_TRY", JSON.stringify({ keyId: k.id, ok }));
        if (ok) return apiKey;
      } catch (e) {
        console.warn("OFFSH_KEY_DECRYPT_FAIL", JSON.stringify({ keyId: k.id, err: String((e as any)?.message || e) }));
      }
    }
    return null;
  } catch (e) {
    console.warn("OFFSH_KEY_LOAD_ERR", e);
    return null;
  }
}

// ---------- GraphQL: bankWithdraw ----------
async function bankWithdrawAllianceToAlliance(opts: {
  srcAllianceId: number;
  dstAllianceId: number;
  payload: Record<string, number>;
  apiKey: string;            // URL context (sender)
  botKey: string;            // X-Bot-Key
  actorApiKey: string;       // X-Api-Key (offshore)
  note?: string;
}): Promise<boolean> {
  const fields: string[] = [];
  for (const [k, v] of Object.entries(opts.payload)) {
    const n = Number(v) || 0;
    if (n > 0) fields.push(`${k}:${n}`);
  }
  if (!fields.length) return false;
  if (opts.note) fields.push(`note:${JSON.stringify(opts.note)}`);

  const q = `mutation {
    bankWithdraw(receiver:${opts.dstAllianceId}, receiver_type:2, ${fields.join(",")}) { id }
  }`;

  const url = new URL(GQL_URL);
  url.searchParams.set("api_key", opts.apiKey);

  try {
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Api-Key": opts.actorApiKey,
        "X-Bot-Key": opts.botKey,
      },
      body: JSON.stringify({ query: q }),
    });
    const data: any = await resp.json().catch(() => ({} as any));
    if (!resp.ok || data?.errors) {
      console.error(
        "OFFSH_SEND_ERR",
        resp.status,
        JSON.stringify({ msg: data?.errors?.[0]?.message || data, src: opts.srcAllianceId, dst: opts.dstAllianceId })
      );
      return false;
    }
    return Boolean(data?.data?.bankWithdraw?.id);
  } catch (e) {
    console.error("OFFSH_SEND_EXC", e);
    return false;
  }
}

// ---------- Pricing ----------
let priceCache: { at: number; prices: PriceMap; source: string; asOf: string } | null = null; // asOf is ISO string
const PRICE_CACHE_MS = 300_000;
async function getAveragePricesCached(): Promise<{ prices: PriceMap; source: string; asOf: string } | null> {
  const now = Date.now();
  if (priceCache && (now - priceCache.at < PRICE_CACHE_MS)) return priceCache;
  const pricing = await fetchAveragePrices();
  if (!pricing) return null;
  priceCache = { at: now, prices: pricing.prices, source: pricing.source, asOf: pricing.asOf };
  return priceCache;
}

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

function renderPretty(qtys: Partial<Record<Resource, number>>, prices: PriceMap) {
  const fields: { name: string; value: string; inline: boolean }[] = [];
  const missing: string[] = [];
  let anyPriced = false;

  const getPrice = (res: Resource) =>
    Number.isFinite(prices[res] as number) ? (prices[res] as number) : undefined;

  for (const { key, label } of ORDER) {
    const qty = Number(qtys[key] ?? 0);
    if (!qty) continue;

    const price = getPrice(key);
    if (price === undefined) {
      const qtyStr = key === "money" ? `$${Math.round(qty).toLocaleString("en-US")}` : qty.toLocaleString("en-US");
      fields.push({ name: `${E[key]} ${label}`, value: `*price unavailable*\n${qtyStr}`, inline: true });
      if (key !== "money") missing.push(label);
      continue;
    }
    const qtyStr = key === "money" ? `$${Math.round(qty).toLocaleString("en-US")}` : qty.toLocaleString("en-US");
    const priceStr = key === "money" ? "$1" : `$${Number(price).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    const valueStr = fmtMoney(qty * price);
    fields.push({ name: `${E[key]} ${label}`, value: `**${valueStr}**\n${qtyStr} × ${priceStr}`, inline: true });
    anyPriced = true;
  }

  if (!anyPriced && (qtys.money ?? 0) > 0) {
    const money = Number(qtys.money ?? 0);
    fields.push({ name: `${E.money} Money`, value: `**${fmtMoney(money)}**\n$${Math.round(money).toLocaleString("en-US")} × $1`, inline: true });
  }

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
    },
    prices
  );

  return { fields, total, missing };
}

// ---------- Slash Command (builder) ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore banking controls")
  .addSubcommand((sc) => sc.setName("show").setDescription("Show the effective offshore configuration and controls"))
  .addSubcommand((sc) =>
    sc.setName("set_default")
      .setDescription("BOT ADMIN: set the global default offshore alliance id")
      .addIntegerOption((o) => o.setName("alliance_id").setDescription("Alliance ID for global default (blank to clear)").setRequired(false)),
  )
  .addSubcommand((sc) =>
    sc.setName("set_override")
      .setDescription("Set or clear this alliance’s offshore override")
      .addIntegerOption((o) => o.setName("alliance_id").setDescription("Alliance ID for override (blank to clear)").setRequired(false)),
  )
  .addSubcommand((sc) =>
    sc.setName("holdings").setDescription("Show what YOUR alliance is holding in the offshore (running balance; bot-tagged only)"),
  )
  .addSubcommand((sc) =>
    sc.setName("send").setDescription("Send from your alliance bank to the configured offshore (guided modal)"),
  );

// ---------- Slash Command: execute ----------
export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand(true);

  const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
  const legacy = i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null;
  const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;

  if (!alliance) {
    return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
  }

  if (sub === "show") {
    await i.deferReply({ ephemeral: true });
    const { global, override, effective } = await resolveOffshoreAid(alliance.id);

    const embed = new EmbedBuilder()
      .setTitle("🏦 Offshore Configuration")
      .setColor(Colors.Blurple)
      .addFields(
        { name: "Alliance", value: `${alliance.name || alliance.id}`, inline: true },
        { name: "Global default", value: global ? `**${global}**` : "—", inline: true },
        { name: "Override", value: override ? `**${override}**` : "—", inline: true },
        { name: "Effective offshore", value: effective ? `**${effective}**` : "—", inline: false },
      )
      .setFooter({ text: `as of ${nowIso()}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("📤").setLabel("Send to Offshore"),
      new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setEmoji("📊").setLabel("Show Holdings"),
    );

    await i.editReply({ embeds: [embed], components: [row] });
    return;
  }

  if (sub === "set_default") {
    if (i.user.id !== (process.env.BOT_ADMIN_DISCORD_ID || "")) {
      return i.reply({ content: "Only the bot admin can set the global default offshore.", ephemeral: true });
    }
    const raw = i.options.getInteger("alliance_id", false);
    const aid = raw && raw > 0 ? raw : null;
    await setDefaultOffshore(aid, i.user.id);
    return i.reply({ content: `✅ Global default offshore set → **${aid ?? "—"}**.`, ephemeral: true });
  }

  if (sub === "set_override") {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ content: "You lack permission to set overrides.", ephemeral: true });
    }
    const raw = i.options.getInteger("alliance_id", false);
    const aid = raw && raw > 0 ? raw : null;
    await prisma.alliance.update({ where: { id: alliance.id }, data: { offshoreOverrideAllianceId: aid } });
    return i.reply({ content: `✅ Override set → **${aid ?? "—"}**.`, ephemeral: true });
  }

  if (sub === "holdings") {
    await i.deferReply({ ephemeral: true });

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.editReply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default." });
    }

    try {
      // Incrementally catch up ledger from offshore’s recent bankrecs
      const ledger = await catchUpLedgerForPair(alliance.id, offshoreAid, 500);

      const qtys: Partial<Record<Resource, number>> = {
        money: Number(ledger.money),
        food: Number(ledger.food),
        coal: Number(ledger.coal),
        oil: Number(ledger.oil),
        uranium: Number(ledger.uranium),
        lead: Number(ledger.lead),
        iron: Number(ledger.iron),
        bauxite: Number(ledger.bauxite),
        gasoline: Number(ledger.gasoline),
        munitions: Number(ledger.munitions),
        steel: Number(ledger.steel),
        aluminum: Number(ledger.aluminum),
      };

      const pricing = await getAveragePricesCached();
      if (!pricing) return i.editReply("Market data is unavailable right now. Please try again later.");

      const { fields, total, missing } = renderPretty(qtys, pricing.prices);

      const embed = new EmbedBuilder()
        .setTitle(`📊 Offshore Holdings — ${alliance.name || alliance.id}`)
        .setColor(Colors.Green)
        .setDescription(
          [
            `**${alliance.name || alliance.id}** held in offshore **${offshoreAid}**`,
            `_Running balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”) • as of ${nowIso()}_`,
          ].join("\n"),
        )
        .addFields(
          ...fields,
          { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false },
        )
        .setFooter({
          text: [`Prices: ${pricing.source}`, `As of ${new Date(pricing.asOf).toLocaleString()}`]
            .concat(missing.length ? [`No prices for: ${missing.join(", ")}`] : [])
            .join(" • "),
        });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setEmoji("🔄").setLabel("Refresh"),
      );

      await i.editReply({ embeds: [embed], components: [row] });
    } catch (e) {
      console.error("[OFFSH_HOLDINGS_ERR]", e);
      await i.editReply({ content: "Couldn’t compute holdings right now. Try again shortly." });
    }
    return;
  }

  if (sub === "send") {
    return openSendModal(i, alliance.id, 0);
  }

  return i.reply({ content: "Unknown offshore subcommand.", ephemeral: true });
}

// ---------- Send: Paged modal flow ----------
const PAGE_SIZE = 5;
function pageCountAll() { return Math.ceil(RESOURCE_KEYS.length / PAGE_SIZE); }
function pageSlice(page: number) { const s = page * PAGE_SIZE; return RESOURCE_KEYS.slice(s, s + PAGE_SIZE); }

const sendSessions: Map<string, { allianceId: number; data: Record<string, number>; createdAt: number }> = new Map();

async function openSendModal(i: Interaction, allianceId: number, page: number) {
  try {
    const keys = pageSlice(page);
    const total = pageCountAll();
    const modal = new ModalBuilder().setCustomId(`offsh:modal:${page}`).setTitle(`📤 Offshore Send (${page + 1}/${total})`);

    for (const k of keys) {
      const input = new TextInputBuilder()
        .setCustomId(k)
        .setLabel(`${k} (enter amount)`)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("0");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }

    // Works for both Button and SlashCommand interactions
    // @ts-ignore
    await i.showModal(modal);

    const u = (i as any).user?.id || "unknown";
    const sess = sendSessions.get(u) || { allianceId, data: {}, createdAt: Date.now() };
    sendSessions.set(u, sess);
  } catch (e) {
    console.error("[OFFSH_MODAL_OPEN_ERR]", e);
    try { await (i as any).reply({ content: "Couldn’t open the modal. Try again.", ephemeral: true }); } catch {}
  }
}

export async function handleModal(i: Interaction) {
  if (!("isModalSubmit" in i) || !(i as any).isModalSubmit()) return;
  if (!(i as any).customId?.startsWith?.("offsh:modal:")) return;

  try {
    const m = (i as any).customId.match(/^offsh:modal:(\d+)$/);
    if (!m) return;
    const page = Number(m[1] || 0);

    const map = (i as any).guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: (i as any).guildId } }) : null;
    const legacy = (i as any).guildId ? await prisma.alliance.findFirst({ where: { guildId: (i as any).guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) {
      return (i as any).reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
    }

    const u = (i as any).user?.id || "unknown";
    const sess = sendSessions.get(u) || { allianceId: alliance.id, data: {}, createdAt: Date.now() };

    const keys = pageSlice(page);
    for (const k of keys) {
      const raw = ((i as any).fields.getTextInputValue(k) || "").trim();
      if (!raw) { delete sess.data[k]; continue; }
      const num = parseNum(raw);
      if (!Number.isFinite(num) || num < 0) {
        return (i as any).reply({ content: `Invalid number for ${k}.`, ephemeral: true });
      }
      if (num > 0) sess.data[k] = num; else delete sess.data[k];
    }
    sendSessions.set(u, sess);

    const total = pageCountAll();
    const parts: string[] = [];
    for (const [k, v] of Object.entries(sess.data)) if (Number(v) > 0) parts.push(`• **${k}**: ${fmt(Number(v))}`);
    const summary = parts.join("\n") || "— none yet —";

    const btns: ButtonBuilder[] = [];
    if (page > 0) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel("◀ Prev"));
    if (page < total - 1) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page + 1}`).setStyle(ButtonStyle.Primary).setLabel(`Next (${page + 2}/${total}) ▶`));
    btns.push(new ButtonBuilder().setCustomId("offsh:done").setStyle(ButtonStyle.Success).setLabel("Done ✅"));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
    await (i as any).reply({ content: `Saved so far:\n${summary}`, components: [row], ephemeral: true });
  } catch (e) {
    console.error("[OFFSH_MODAL_ERR]", e);
    try { await (i as any).reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
}

export async function handleButton(i: Interaction) {
  if (!("isButton" in i) || !(i as any).isButton()) return;

  // Paging open
  if ((i as any).customId?.startsWith?.("offsh:open:")) {
    const m = (i as any).customId.match(/^offsh:open:(\d+)$/);
    const page = m ? Math.max(0, parseInt(m[1]!, 10)) : 0;

    const map = (i as any).guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: (i as any).guildId } }) : null;
    const legacy = (i as any).guildId ? await prisma.alliance.findFirst({ where: { guildId: (i as any).guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) {
      return (i as any).reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
    }

    return openSendModal(i, alliance.id, page);
  }

  // Finalize send
  if ((i as any).customId === "offsh:done") {
    const u = (i as any).user?.id || "unknown";
    const sess = sendSessions.get(u);
    if (!sess || !Object.keys(sess.data).length) {
      return (i as any).reply({ content: "Nothing to send — all zero. Use **/offshore send**.", ephemeral: true });
    }

    const alliance = await prisma.alliance.findUnique({ where: { id: sess.allianceId } });
    if (!alliance) return (i as any).reply({ content: "Alliance not found.", ephemeral: true });

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return (i as any).reply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default.", ephemeral: true });
    }

    const botKey = process.env.PNW_BOT_KEY || "";
    if (!botKey) {
      return (i as any).reply({ content: "Bot is missing PNW_BOT_KEY on the host. Ask the admin.", ephemeral: true });
    }

    // Sender (source) alliance api key
    const apiKey = await getAllianceApiKeyFor(alliance.id);
    if (!apiKey) {
      return (i as any).reply({
        content: "No valid Alliance API key was found for this alliance. Use **/setup_alliance** to save one.",
        ephemeral: true,
      });
    }

    // Actor header key → OFFSHORE alliance's key
    const actorApiKey = await getAllianceApiKeyFor(offshoreAid);
    if (!actorApiKey) {
      return (i as any).reply({
        content: `No valid API key was found for your offshore alliance **${offshoreAid}**. Run **/setup_alliance** in that server to save one.`,
        ephemeral: true,
      });
    }

    try {
      const note = `${OFFSH_NOTE_TAG} • src ${alliance.id} -> off ${offshoreAid} • by ${(i as any).user.id}`;
      const ok = await bankWithdrawAllianceToAlliance({
        srcAllianceId: alliance.id,
        dstAllianceId: offshoreAid,
        payload: sess.data,
        apiKey, botKey, actorApiKey, note,
      });

      if (ok) {
        sendSessions.delete(u);
        return (i as any).reply({
          content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nCheck **Show Holdings** to see the running balance.`,
          ephemeral: true,
        });
      } else {
        const lines = Object.entries(sess.data).map(([k, v]) => `• ${k}: ${fmt(Number(v))}`).join("\n");
        const embed = new EmbedBuilder()
          .setTitle("📤 Manual offshore transfer")
          .setDescription(`Use your **Alliance → Alliance** banker UI to send to **Alliance ${offshoreAid}**.\nPaste the note below.`)
          .addFields({ name: "Amounts", value: lines || "—" }, { name: "Note", value: `\`${note}\`` })
          .setColor(Colors.Yellow);
        sendSessions.delete(u);
        return (i as any).reply({ embeds: [embed], ephemeral: true });
      }
    } catch (e) {
      console.error("[OFFSH_DONE_ERR]", e);
      return (i as any).reply({ content: "Send failed. Check logs with OFFSH_* markers.", ephemeral: true });
    }
  }

  // Quick holdings button (reads running ledger)
  if ((i as any).customId === "offsh:check") {
    await (i as any).deferReply({ ephemeral: true });

    const map = (i as any).guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: (i as any).guildId } }) : null;
    const legacy = (i as any).guildId ? await prisma.alliance.findFirst({ where: { guildId: (i as any).guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) return (i as any).editReply({ content: "This server is not linked yet. Run /setup_alliance first." });

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) return (i as any).editReply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default." });

    try {
      const ledger = await catchUpLedgerForPair(alliance.id, offshoreAid, 500);

      const qtys: Partial<Record<Resource, number>> = {
        money: Number(ledger.money),
        food: Number(ledger.food),
        coal: Number(ledger.coal),
        oil: Number(ledger.oil),
        uranium: Number(ledger.uranium),
        lead: Number(ledger.lead),
        iron: Number(ledger.iron),
        bauxite: Number(ledger.bauxite),
        gasoline: Number(ledger.gasoline),
        munitions: Number(ledger.munitions),
        steel: Number(ledger.steel),
        aluminum: Number(ledger.aluminum),
      };

      const pricing = await getAveragePricesCached();
      if (!pricing) return (i as any).editReply("Market data is unavailable right now. Please try again later.");

      const { fields, total, missing } = renderPretty(qtys, pricing.prices);

      const embed = new EmbedBuilder()
        .setTitle(`📊 Offshore Holdings — ${alliance.name || alliance.id}`)
        .setColor(Colors.Green)
        .setDescription(
          [
            `**${alliance.name || alliance.id}** held in offshore **${offshoreAid}**`,
            `_Running balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”) • as of ${nowIso()}_`,
          ].join("\n"),
        )
        .addFields(...fields, { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false })
        .setFooter({
          text: [`Prices: ${pricing.source}`, `As of ${new Date(pricing.asOf).toLocaleString()}`]
            .concat(missing.length ? [`No prices for: ${missing.join(", ")}`] : [])
            .join(" • "),
        });

      await (i as any).editReply({ embeds: [embed] });
      return;
    } catch (e) {
      console.error("[OFFSH_BTN_HOLDINGS_ERR]", e);
      return (i as any).editReply({ content: "Couldn’t compute holdings right now. Try again shortly." });
    }
  }
}
