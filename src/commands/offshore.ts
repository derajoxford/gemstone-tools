// src/commands/offshore.ts
//
// Offshore controller: show / set default / set override / holdings / send (modal).
// SEND FLOW UNCHANGED (uses Alliance key + X-Bot-Key).
// HOLDINGS now renders from ledger immediately, catch-up runs in background.

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
  ButtonInteraction,
  Interaction,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { RESOURCE_KEYS, fetchBankrecs } from "../lib/pnw";
import { getDefaultOffshore, setDefaultOffshore } from "../lib/offshore";
import { open } from "../lib/crypto";
import { catchUpLedgerForPair, readLedger, OFFSH_NOTE_TAG } from "../lib/offshore_ledger";
import { fetchAveragePrices, fmtMoney, computeTotalValue, PriceMap, Resource } from "../lib/market";

const prisma = new PrismaClient();

// ---------- small utils ----------
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

// ---------- market value helpers ----------
const ORDER: Array<{ key: Resource; label: string; emoji: string }> = [
  { key: "money", label: "Money", emoji: "💵" },
  { key: "food", label: "Food", emoji: "🍞" },
  { key: "coal", label: "Coal", emoji: "⚫" },
  { key: "oil", label: "Oil", emoji: "🛢️" },
  { key: "uranium", label: "Uranium", emoji: "☢️" },
  { key: "lead", label: "Lead", emoji: "🔩" },
  { key: "iron", label: "Iron", emoji: "⛓️" },
  { key: "bauxite", label: "Bauxite", emoji: "🧱" },
  { key: "gasoline", label: "Gasoline", emoji: "⛽" },
  { key: "munitions", label: "Munitions", emoji: "💣" },
  { key: "steel", label: "Steel", emoji: "🛠️" },
  { key: "aluminum", label: "Aluminum", emoji: "🧪" },
];

type PriceCache = { at: number; prices: PriceMap; asOf: string; source: string } | null;
let priceCache: PriceCache = null;
async function getPrices(): Promise<NonNullable<PriceCache>> {
  const now = Date.now();
  if (priceCache && now - priceCache.at < 5 * 60 * 1000) return priceCache!;
  const pricing = await fetchAveragePrices();
  if (!pricing) throw new Error("pricing unavailable");
  priceCache = { at: now, prices: pricing.prices, source: pricing.source, asOf: String(pricing.asOf) };
  return priceCache!;
}

// ---------- effective offshore (global default + per-alliance override) ----------
async function resolveOffshoreAid(allianceId: number): Promise<{ global: number | null; override: number | null; effective: number | null }> {
  const global = await getDefaultOffshore();
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  const override = a?.offshoreOverrideAllianceId ?? null;
  return { global, override, effective: override ?? global ?? null };
}

// ---------- fast-estimate (kept for modal placeholders only) ----------
async function estimateAllianceAvailableFromRecent(aid: number, limit = 100) {
  try {
    const rows = await fetchBankrecs(aid, { limit });
    const totals: Record<string, number> = {};
    for (const k of RESOURCE_KEYS) totals[k] = 0;

    for (const r of rows) {
      const sType = Number((r as any).sender_type || 0);
      const rType = Number((r as any).receiver_type || 0);
      const sId = String((r as any).sender_id || "");
      const rId = String((r as any).receiver_id || "");
      const isOut = (sType === 2 || sType === 3) && sId === String(aid);
      const isIn = (rType === 2 || rType === 3) && rId === String(aid);
      for (const k of RESOURCE_KEYS) {
        const v = Number((r as any)[k] || 0);
        if (!Number.isFinite(v) || v === 0) continue;
        if (isIn) totals[k] += v;
        if (isOut) totals[k] -= v;
      }
    }
    return totals;
  } catch (e) {
    console.warn("[OFFSH_ESTIMATE_ERR]", e);
    const zeros: Record<string, number> = {};
    for (const k of RESOURCE_KEYS) zeros[k] = 0;
    return zeros;
  }
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
    console.info("OFFSH_KEY_SCAN", JSON.stringify({ aid, totalKeys: keys.length, keyIds: keys.map(k => k.id) }));
    for (const k of keys) {
      try {
        const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
        const ok = await validateApiKeyForAlliance(apiKey, aid);
        console.info("OFFSH_KEY_TRY", JSON.stringify({ keyId: k.id, ok }));
        if (ok) return apiKey;
      } catch {
        // ignore decryption errors and keep trying older keys
      }
    }
    return null;
  } catch (e) {
    console.warn("OFFSH_KEY_LOAD_ERR", e);
    return null;
  }
}

// ---------- GraphQL: bankWithdraw (Alliance→Alliance for offshore) ----------
async function bankWithdrawAllianceToAlliance(opts: {
  srcAllianceId: number;
  dstAllianceId: number;
  payload: Record<string, number>;
  apiKey: string;
  botKey: string;
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
        "X-Api-Key": opts.apiKey,
        "X-Bot-Key": opts.botKey,
      },
      body: JSON.stringify({ query: q }),
    });
    const data: any = await resp.json().catch(() => ({} as any));
    if (!resp.ok || data?.errors) {
      console.error("OFFSH_SEND_ERR", resp.status, data?.errors?.[0]?.message || data, JSON.stringify({ dst: opts.dstAllianceId, src: opts.srcAllianceId, fields: opts.payload, hasBotKey: !!opts.botKey }));
      return false;
    }
    return Boolean(data?.data?.bankWithdraw?.id);
  } catch (e) {
    console.error("OFFSH_SEND_EXC", e);
    return false;
  }
}

// ---------- Slash Command (builder) ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore banking controls")
  .addSubcommand((sc) => sc.setName("show").setDescription("Show the effective offshore configuration and controls"))
  .addSubcommand((sc) =>
    sc
      .setName("set_default")
      .setDescription("BOT ADMIN: set the global default offshore alliance id")
      .addIntegerOption((o) => o.setName("alliance_id").setDescription("Alliance ID for global default (blank to clear)").setRequired(false)),
  )
  .addSubcommand((sc) =>
    sc
      .setName("set_override")
      .setDescription("Set or clear this alliance’s offshore override")
      .addIntegerOption((o) => o.setName("alliance_id").setDescription("Alliance ID for override (blank to clear)").setRequired(false)),
  )
  .addSubcommand((sc) => sc.setName("holdings").setDescription("Show your alliance’s net holdings in your offshore (running ledger)"))
  .addSubcommand((sc) => sc.setName("send").setDescription("Send from your alliance bank to the configured offshore (guided modal)"));

// ---------- Slash Command: execute ----------
export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand(true);
  // Resolve alliance by guild mapping
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
    await renderHoldingsFast(i, alliance.id);
    return;
  }

  if (sub === "send") {
    return openSendModal(i, alliance.id, 0);
  }

  return i.reply({ content: "Unknown offshore subcommand.", ephemeral: true });
}

// ---------- FAST HOLDINGS RENDER (ledger first, then background catch-up) ----------
async function renderHoldingsFast(i: ChatInputCommandInteraction | ButtonInteraction, allianceId: number) {
  await i.deferReply({ ephemeral: true });

  const { effective: offshoreAid } = await resolveOffshoreAid(allianceId);
  if (!offshoreAid) {
    return i.editReply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default." });
  }

  // 1) Read ledger immediately
  const row = await readLedger(prisma, allianceId, offshoreAid);
  if (!row) {
    // Ensure the row exists and render zeros
    await catchUpLedgerForPair(prisma, allianceId, offshoreAid, { maxLoops: 0 });
  }
  const ledger = await readLedger(prisma, allianceId, offshoreAid);

  // 2) Prices
  let pricesInfo: { prices: PriceMap; source: string; asOf: string };
  try {
    const p = await getPrices();
    pricesInfo = { prices: p.prices, source: p.source, asOf: p.asOf };
  } catch {
    pricesInfo = { prices: {} as any, source: "unknown", asOf: new Date().toISOString() };
  }

  // 3) Build pretty embed from ledger values
  const qtys: Partial<Record<Resource, number>> = {};
  for (const { key } of ORDER) {
    // @ts-ignore
    qtys[key] = Number((ledger as any)?.[key] ?? 0);
  }

  const fields: { name: string; value: string; inline: boolean }[] = [];
  for (const { key, label, emoji } of ORDER) {
    const qty = Number(qtys[key] ?? 0);
    if (!qty) continue;
    const isMoney = key === "money";
    const price = isMoney ? 1 : Number(pricesInfo.prices[key] ?? 0) || 0;
    const qtyStr = isMoney ? `$${Math.round(qty).toLocaleString("en-US")}` : qty.toLocaleString("en-US");
    const priceStr = isMoney ? "$1" : (price ? `$${Math.round(price).toLocaleString("en-US")}` : "*n/a*");
    const valueStr = isMoney ? fmtMoney(qty) : (price ? fmtMoney(qty * price) : "*n/a*");

    fields.push({
      name: `${emoji} ${label}`,
      value: `${valueStr}\n${qtyStr} × ${priceStr}`,
      inline: true,
    });
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
    pricesInfo.prices
  );

  const titleAlliance = (await prisma.alliance.findUnique({ where: { id: allianceId } }))?.name || String(allianceId);
  const embed = new EmbedBuilder()
    .setTitle(`📊 Offshore Holdings — ${titleAlliance}`)
    .setColor(Colors.Green)
    .setDescription(`${allianceId} held in offshore ${offshoreAid}\nRunning balance (bot-tagged only • note contains “${OFFSH_NOTE_TAG}”)`)
    .addFields(
      ...(fields.length ? fields : [{ name: "—", value: "No holdings yet.", inline: false }]),
      { name: "Total Market Value", value: `🎯 **${fmtMoney(total)}**`, inline: false }
    )
    .setFooter({ text: `Prices: ${pricesInfo.source} • As of ${new Date(pricesInfo.asOf).toLocaleString()} • Ledger updated ${new Date(ledger?.updatedAt ?? Date.now()).toLocaleString()}` });

  const rowBtns = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("offsh:refresh").setStyle(ButtonStyle.Secondary).setLabel("Refresh (fast)"),
    new ButtonBuilder().setCustomId("offsh:rescan").setStyle(ButtonStyle.Secondary).setLabel("Force Rescan (slow)")
  );

  await i.editReply({ embeds: [embed], components: [rowBtns] });

  // 4) Kick off background catch-up (non-blocking)
  //    This keeps future reads instant without making this interaction wait.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  (async () => {
    try {
      await catchUpLedgerForPair(prisma, allianceId, offshoreAid, { maxLoops: 20, batchSize: 500 });
    } catch (e) {
      console.warn("[OFFSH_LEDGER_BG_ERR]", e);
    }
  })();
}

// ---------- Send: Paged modal flow ----------
const PAGE_SIZE = 5;
function pageCountAll() {
  return Math.ceil(RESOURCE_KEYS.length / PAGE_SIZE);
}
function pageSlice(page: number) {
  const s = page * PAGE_SIZE;
  return RESOURCE_KEYS.slice(s, s + PAGE_SIZE);
}

// Keep per-user session across modal pages
const sendSessions: Map<string, { allianceId: number; data: Record<string, number>; createdAt: number }> = new Map();

async function openSendModal(i: Interaction, allianceId: number, page: number) {
  try {
    const approxAvail = await estimateAllianceAvailableFromRecent(allianceId, 100);

    const keys = pageSlice(page);
    const total = pageCountAll();
    const modal = new ModalBuilder().setCustomId(`offsh:modal:${page}`).setTitle(`📤 Offshore Send (${page + 1}/${total})`);

    for (const k of keys) {
      const avail = Number(approxAvail[k] || 0);
      const input = new TextInputBuilder()
        .setCustomId(k)
        .setLabel(`${k} (≈ avail: ${fmt(avail)})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("0");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    }

    if (i.isButton()) {
      await i.showModal(modal);
    } else if ("showModal" in i) {
      // Chat input command interaction also exposes showModal
      // @ts-ignore
      await i.showModal(modal);
    } else {
      // @ts-ignore
      await i.showModal(modal);
    }

    const sess = sendSessions.get(i.user.id) || { allianceId, data: {}, createdAt: Date.now() };
    sendSessions.set(i.user.id, sess);
  } catch (e) {
    console.error("[OFFSH_MODAL_OPEN_ERR]", e);
    try {
      // @ts-ignore
      await (i as any).reply({ content: "Couldn’t open the modal. Try again.", ephemeral: true });
    } catch {}
  }
}

export async function handleModal(i: Interaction) {
  if (!i.isModalSubmit()) return;
  if (!i.customId.startsWith("offsh:modal:")) return;

  try {
    const m = i.customId.match(/^offsh:modal:(\d+)$/);
    if (!m) return;
    const page = Number(m[1] || 0);

    const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
    const legacy = i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) {
      return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
    }

    const sess = sendSessions.get(i.user.id) || { allianceId: alliance.id, data: {}, createdAt: Date.now() };

    const keys = pageSlice(page);
    for (const k of keys) {
      const raw = (i.fields.getTextInputValue(k) || "").trim();
      if (!raw) {
        delete sess.data[k];
        continue;
      }
      const num = parseNum(raw);
      if (!Number.isFinite(num) || num < 0) {
        return i.reply({ content: `Invalid number for ${k}.`, ephemeral: true });
      }
      if (num > 0) sess.data[k] = num;
      else delete sess.data[k];
    }
    sendSessions.set(i.user.id, sess);

    const total = pageCountAll();
    const parts: string[] = [];
    for (const [k, v] of Object.entries(sess.data)) {
      if (Number(v) > 0) parts.push(`• **${k}**: ${fmt(Number(v))}`);
    }
    const summary = parts.join("\n") || "— none yet —";

    const btns: ButtonBuilder[] = [];
    if (page > 0) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel("◀ Prev"));
    if (page < total - 1) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page + 1}`).setStyle(ButtonStyle.Primary).setLabel(`Next (${page + 2}/${total}) ▶`));
    btns.push(new ButtonBuilder().setCustomId("offsh:done").setStyle(ButtonStyle.Success).setLabel("Done ✅"));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
    await i.reply({ content: `Saved so far:\n${summary}`, components: [row], ephemeral: true });
  } catch (e) {
    console.error("[OFFSH_MODAL_ERR]", e);
    try { await (i as any).reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
}

export async function handleButton(i: Interaction) {
  if (!i.isButton()) return;

  // Paging open
  if (i.customId.startsWith("offsh:open:")) {
    const m = i.customId.match(/^offsh:open:(\d+)$/);
    const page = m ? Math.max(0, parseInt(m[1]!, 10)) : 0;

    const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
    const legacy = i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) {
      return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
    }

    return openSendModal(i, alliance.id, page);
  }

  if (i.customId === "offsh:done") {
    const sess = sendSessions.get(i.user.id);
    if (!sess || !Object.keys(sess.data).length) {
      return i.reply({ content: "Nothing to send — all zero. Use **/offshore send**.", ephemeral: true });
    }

    const alliance = await prisma.alliance.findUnique({ where: { id: sess.allianceId } });
    if (!alliance) return i.reply({ content: "Alliance not found.", ephemeral: true });

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.reply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default.", ephemeral: true });
    }

    const botKey = process.env.PNW_BOT_KEY || "";
    if (!botKey) {
      return i.reply({ content: "Bot is missing PNW_BOT_KEY on the host. Ask the admin.", ephemeral: true });
    }

    const apiKey = await getAllianceApiKeyFor(alliance.id);
    if (!apiKey) {
      return i.reply({
        content: "No valid Alliance API key was found for this alliance. Use **/setup_alliance** to save one.",
        ephemeral: true,
      });
    }

    try {
      const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${i.user.id}`;
      const ok = await bankWithdrawAllianceToAlliance({
        srcAllianceId: alliance.id,
        dstAllianceId: offshoreAid,
        payload: sess.data,
        apiKey,
        botKey,
        note,
      });

      if (ok) {
        sendSessions.delete(i.user.id);
        return i.reply({
          content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nVerify with **/offshore holdings** shortly.`,
          ephemeral: true,
        });
      } else {
        const lines = Object.entries(sess.data)
          .map(([k, v]) => `• ${k}: ${fmt(Number(v))}`)
          .join("\n");
        const embed = new EmbedBuilder()
          .setTitle("📤 Manual offshore transfer")
          .setDescription(
            `Use your **Alliance → Alliance** banker UI to send to **Alliance ${offshoreAid}**.\nPaste the note below.`,
          )
          .addFields({ name: "Amounts", value: lines || "—" }, { name: "Note", value: `\`${note}\`` })
          .setColor(Colors.Yellow);

        sendSessions.delete(i.user.id);
        return i.reply({ embeds: [embed], ephemeral: true });
      }
    } catch (e) {
      console.error("[OFFSH_DONE_ERR]", e);
      return i.reply({ content: "Send failed. Check logs with OFFSH_* markers.", ephemeral: true });
    }
  }

  // Show holdings buttons
  if (i.customId === "offsh:check") {
    const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
    const legacy = i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
    // Instant render
    // @ts-ignore
    return renderHoldingsFast(i as any, alliance.id);
  }

  if (i.customId === "offsh:refresh") {
    await i.deferReply({ ephemeral: true });
    const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
    const legacy = i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) return i.editReply({ content: "This server is not linked yet. Run /setup_alliance first." });
    // Just re-read ledger and render
    // @ts-ignore
    return renderHoldingsFast(i as any, alliance.id);
  }

  if (i.customId === "offsh:rescan") {
    await i.deferReply({ ephemeral: true });
    const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
    const legacy = i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) return i.editReply({ content: "This server is not linked yet. Run /setup_alliance first." });

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) return i.editReply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default." });

    try {
      // Do an on-demand catch-up (blocking)
      await catchUpLedgerForPair(prisma, alliance.id, offshoreAid, { maxLoops: 100, batchSize: 1000 });
    } catch (e) {
      console.error("[OFFSH_BTN_RESCAN_ERR]", e);
    }
    // Then render
    // @ts-ignore
    return renderHoldingsFast(i as any, alliance.id);
  }
}

// NOTE: routing
// - /offshore slash command → execute()
// - Buttons with customId starting "offsh:" → handleButton()
// - Modals with customId starting "offsh:modal:" → handleModal()
