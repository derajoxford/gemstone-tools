// src/commands/offshore.ts
//
// Offshore controller: show / set default / set override / holdings / send (modal).
//
// ✅ Send auth model (already proven by curl; DO NOT CHANGE):
//   - URL  ?api_key=  → SENDER alliance key (the main alliance moving funds)
//   - HEAD X-Api-Key  → OFFSHORE alliance saved key (actor header)
//   - HEAD X-Bot-Key  → mutations key (PNW_BOT_KEY)
//
// 📊 Holdings (leader view):
//   - /offshore holdings  → shows only what THIS alliance is holding in the offshore
//     (pairwise net: A→Off minus Off→A, computed from the offshore’s recent bankrecs window)
//   - The “Show Holdings” button mirrors the same view.
//   - Embed includes a Total Market Value similar to /market_value (best-effort).
//
// Requirements (env):
//   BOT_ADMIN_DISCORD_ID
//   PNW_BOT_KEY
//   PNW_GRAPHQL_URL (optional; defaults to official)

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
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { RESOURCE_KEYS, fetchBankrecs } from "../lib/pnw";
import { getDefaultOffshore, setDefaultOffshore } from "../lib/offshore";
import { open } from "../lib/crypto";

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

// ---------- effective offshore (global default + per-alliance override) ----------
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

// Try newest→oldest AllianceKey; return first valid apiKey (decrypted).
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

// ---------- GraphQL: bankWithdraw (Alliance→Alliance for offshore) ----------
// URL ?api_key=  → sender alliance key
// HEAD X-Api-Key → offshore alliance key (actor)
// HEAD X-Bot-Key → PNW_BOT_KEY
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
      console.error("OFFSH_SEND_ERR", resp.status, JSON.stringify({ msg: data?.errors?.[0]?.message || data, src: opts.srcAllianceId, dst: opts.dstAllianceId }));
      return false;
    }
    return Boolean(data?.data?.bankWithdraw?.id);
  } catch (e) {
    console.error("OFFSH_SEND_EXC", e);
    return false;
  }
}

// ---------- Holdings helpers (pairwise net + market value) ----------
function fmtLines(rec: Record<string, number>) {
  const parts = RESOURCE_KEYS
    .map((k) => {
      const v = Number(rec[k] || 0);
      return Math.abs(v) > 0 ? `• **${k}**: ${fmt(v)}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join("\n") : "— none in window —";
}

// Build pairwise net for A (caller) vs Offshore O over a recent window (last `take` bankrecs on O).
async function pairNetWithOffshore(aid: number, offshoreAid: number, take = 500) {
  const rows = await fetchBankrecs(offshoreAid, { limit: take });
  const A = String(aid);
  const O = String(offshoreAid);
  const net: Record<string, number> = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));

  for (const r of rows) {
    const sType = Number((r as any).sender_type || 0);
    const rType = Number((r as any).receiver_type || 0);
    const sId = String((r as any).sender_id || "");
    const rId = String((r as any).receiver_id || "");
    const isAtoO = (sType === 2 || sType === 3) && sId === A && (rType === 2 || rType === 3) && rId === O;
    const isOtoA = (sType === 2 || sType === 3) && sId === O && (rType === 2 || rType === 3) && rId === A;

    for (const k of RESOURCE_KEYS) {
      const v = Number((r as any)[k] || 0);
      if (!Number.isFinite(v) || v === 0) continue;
      if (isAtoO) net[k] += v;
      if (isOtoA) net[k] -= v;
    }
  }
  return net;
}

// Best-effort market prices:
// - Tries to dynamically import an internal market module (if your repo has one used by /market_value).
// - Falls back to money=1 and 0 for others (so it still renders nicely for testing).
async function getMarketPricesSafe(): Promise<Record<string, number>> {
  try {
    // Try common internal module names (ts builds emit .js)
    // @ts-ignore
    const mod = (await import("../lib/market.js")).default || (await import("../lib/market.js"));
    // attempt common exports
    const fn = (mod.getLatestMarketPrices || mod.fetchLatestPrices || mod.getMarketPrices || mod.prices) as (() => Promise<Record<string, number>>) | undefined;
    if (fn) return await fn();
    if (typeof mod === "object") return mod as Record<string, number>;
  } catch {}
  const p: Record<string, number> = {};
  for (const k of RESOURCE_KEYS) p[k] = 0;
  p.money = 1; // at minimum treat money at par
  return p;
}

function computeMarketValue(amounts: Record<string, number>, prices: Record<string, number>) {
  let total = 0;
  for (const k of RESOURCE_KEYS) {
    const qty = Number(amounts[k] || 0);
    const px = Number(prices[k] || 0);
    if (qty && px) total += qty * px;
  }
  return total;
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
  .addSubcommand((sc) =>
    sc.setName("holdings").setDescription("Show what YOUR alliance is holding in the offshore (pair net in recent window)"),
  )
  .addSubcommand((sc) => sc.setName("send").setDescription("Send from your alliance bank to the configured offshore (guided modal)"));

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
    await prisma.alliance.update({
      where: { id: alliance.id },
      data: { offshoreOverrideAllianceId: aid },
    });
    return i.reply({ content: `✅ Override set → **${aid ?? "—"}**.`, ephemeral: true });
  }

  if (sub === "holdings") {
    await i.deferReply({ ephemeral: true });

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.editReply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default." });
    }

    const take = 500;
    try {
      const [net, prices] = await Promise.all([
        pairNetWithOffshore(alliance.id, offshoreAid, take),
        getMarketPricesSafe(),
      ]);
      const totalValue = computeMarketValue(net, prices);

      // Pretty embed that mimics /market_value style
      const embed = new EmbedBuilder()
        .setTitle("📊 Offshore Holdings — Your Alliance")
        .setColor(Colors.Green)
        .setDescription(
          [
            `**${alliance.name || alliance.id}** held in offshore **${offshoreAid}**`,
            `_Window: last ${take} offshore bankrecs • as of ${nowIso()}_`,
          ].join("\n"),
        )
        .addFields(
          { name: "Breakdown", value: fmtLines(net) },
          { name: "Total Market Value (est.)", value: `**$${fmt(totalValue)}**`, inline: true },
        );

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
    // Show the first page of the modal immediately (no defer).
    return openSendModal(i, alliance.id, 0);
  }

  // Fallback
  return i.reply({ content: "Unknown offshore subcommand.", ephemeral: true });
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

    // @ts-ignore
    await i.showModal(modal);

    const u = (i as any).user?.id || "unknown";
    const sess = sendSessions.get(u) || { allianceId, data: {}, createdAt: Date.now() };
    sendSessions.set(u, sess);
  } catch (e) {
    console.error("[OFFSH_MODAL_OPEN_ERR]", e);
    try {
      // @ts-ignore
      await i.reply({ content: "Couldn’t open the modal. Try again.", ephemeral: true });
    } catch {}
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
      if (!raw) {
        delete sess.data[k];
        continue;
      }
      const num = parseNum(raw);
      if (!Number.isFinite(num) || num < 0) {
        return (i as any).reply({ content: `Invalid number for ${k}.`, ephemeral: true });
      }
      if (num > 0) sess.data[k] = num;
      else delete sess.data[k];
    }
    sendSessions.set(u, sess);

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
    await (i as any).reply({ content: `Saved so far:\n${summary}`, components: [row], ephemeral: true });
  } catch (e) {
    console.error("[OFFSH_MODAL_ERR]", e);
    try {
      await (i as any).reply({ content: "Something went wrong.", ephemeral: true });
    } catch {}
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

    // Sender (source) alliance api key (newest→oldest)
    const apiKey = await getAllianceApiKeyFor(alliance.id);
    if (!apiKey) {
      return (i as any).reply({
        content: "No valid Alliance API key was found for this alliance. Use **/setup_alliance** to save one.",
        ephemeral: true,
      });
    }

    // Actor header key → OFFSHORE alliance's saved key (newest→oldest)
    const actorApiKey = await getAllianceApiKeyFor(offshoreAid);
    if (!actorApiKey) {
      return (i as any).reply({
        content: `No valid API key was found for your offshore alliance **${offshoreAid}**. Run **/setup_alliance** in that server to save one.`,
        ephemeral: true,
      });
    }

    // Attempt send
    try {
      const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${(i as any).user.id}`;
      const ok = await bankWithdrawAllianceToAlliance({
        srcAllianceId: alliance.id,
        dstAllianceId: offshoreAid,
        payload: sess.data,
        apiKey,            // URL ?api_key= (sender)
        botKey,            // X-Bot-Key
        actorApiKey,       // X-Api-Key (offshore)
        note,
      });

      if (ok) {
        sendSessions.delete(u);
        return (i as any).reply({
          content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nVerify with **/offshore holdings** shortly.`,
          ephemeral: true,
        });
      } else {
        const lines = Object.entries(sess.data)
          .map(([k, v]) => `• ${k}: ${fmt(Number(v))}`)
          .join("\n");
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

  // Show holdings button (pretty + market value)
  if ((i as any).customId === "offsh:check") {
    await (i as any).deferReply({ ephemeral: true });

    const map = (i as any).guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: (i as any).guildId } }) : null;
    const legacy = (i as any).guildId ? await prisma.alliance.findFirst({ where: { guildId: (i as any).guildId } }) : null;
    const alliance = map ? await prisma.alliance.findUnique({ where: { id: map.allianceId } }) : legacy;
    if (!alliance) {
      return (i as any).editReply({ content: "This server is not linked yet. Run /setup_alliance first." });
    }

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return (i as any).editReply({ content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default." });
    }

    const take = 500;
    try {
      const [net, prices] = await Promise.all([
        pairNetWithOffshore(alliance.id, offshoreAid, take),
        getMarketPricesSafe(),
      ]);
      const totalValue = computeMarketValue(net, prices);

      const embed = new EmbedBuilder()
        .setTitle("📊 Offshore Holdings — Your Alliance")
        .setColor(Colors.Green)
        .setDescription(
          [
            `**${alliance.name || alliance.id}** held in offshore **${offshoreAid}**`,
            `_Window: last ${take} offshore bankrecs • as of ${nowIso()}_`,
          ].join("\n"),
        )
        .addFields(
          { name: "Breakdown", value: fmtLines(net) },
          { name: "Total Market Value (est.)", value: `**$${fmt(totalValue)}**`, inline: true },
        );

      await (i as any).editReply({ embeds: [embed] });
      return;
    } catch (e) {
      console.error("[OFFSH_BTN_HOLDINGS_ERR]", e);
      return (i as any).editReply({ content: "Couldn’t compute holdings right now. Try again shortly." });
    }
  }
}

// NOTE: routing
// - /offshore slash command → execute()
// - Buttons with customId starting "offsh:" → handleButton()
// - Modals with customId starting "offsh:modal:" → handleModal()
