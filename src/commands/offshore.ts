// src/commands/offshore.ts
//
// Offshore controller: show / set default / set override / holdings / send (modal).
// - Key selection: tries AllianceKey newest→oldest, validates per-alliance.
// - Button + modal flow uses customIds "offsh:*".
// - Modal shows best-effort "available" from recent AA bankrecs (PnW doesn’t expose live bank totals).
// - All network errors are logged with OFFSH_* markers for quick grepping.
//
// Requirements:
//   BOT_ADMIN_DISCORD_ID (string Discord user ID)
//   PNW_BOT_KEY (bot key for bankWithdraw)
//   PNW_GRAPHQL_URL (optional; defaults to official GraphQL endpoint)

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

// --- Constants / helpers ---
const GQL_URL = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";

// PnW GraphQL accepts ONLY these resource fields for bankWithdraw.
const ALLOWED_WITHDRAW_KEYS = [
  "money",
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
] as const;
type AllowedKey = (typeof ALLOWED_WITHDRAW_KEYS)[number];

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

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function pickAllowedPositive(payload: Record<string, number>) {
  const out: Record<AllowedKey, number> = {} as any;
  for (const k of ALLOWED_WITHDRAW_KEYS) {
    const v = round2(Number(payload[k] ?? 0));
    if (Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out as Record<string, number>;
}

function firstGqlError(e: any): string | null {
  try {
    if (Array.isArray(e?.errors) && e.errors.length) {
      const msg = e.errors[0]?.message ?? null;
      return msg ? String(msg) : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- effective offshore (global default + per-alliance override) ----------
async function resolveOffshoreAid(allianceId: number): Promise<{ global: number | null; override: number | null; effective: number | null }> {
  const global = await getDefaultOffshore();
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  const override = a?.offshoreOverrideAllianceId ?? null;
  return { global, override, effective: override ?? global ?? null };
}

// ---------- fast-estimate: AA "available" from recent bankrecs ----------
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

// Quick validation that this key can read alliance + bankrecs for the given AID.
async function validateApiKeyForAlliance(apiKey: string, aid: number): Promise<boolean> {
  try {
    const body = {
      query: `query {
        alliances(id:[${aid}], first:1){ data{ id } }
        bankrecs(first:1, alliance_id:${aid}){ data{ id } }
      }`,
    };

    const resp = await fetch(GQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify(body),
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || Array.isArray(json?.errors)) {
      console.warn("OFFSH_KEY_VALIDATE_ERR", resp.status, JSON.stringify(json));
      return false;
    }
    const ok = Boolean(json?.data?.alliances?.data?.length);
    return ok;
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
    for (const k of keys) {
      try {
        const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
        const ok = await validateApiKeyForAlliance(apiKey, aid);
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
  payload: Record<string, number>; // resources with positive amounts
  apiKey: string;
  botKey: string;
  note?: string;
}): Promise<{ ok: boolean; err?: string }> {
  const clean = pickAllowedPositive(opts.payload);
  const fields: string[] = [];
  for (const [k, v] of Object.entries(clean)) {
    const n = Number(v) || 0;
    if (n > 0) fields.push(`${k}:${n}`);
  }
  if (!fields.length) return { ok: false, err: "No positive amounts after filtering" };
  if (opts.note) fields.push(`note:${JSON.stringify(opts.note)}`);

  const q = `mutation {
    bankWithdraw(receiver:${opts.dstAllianceId}, receiver_type:2, ${fields.join(",")}) { id }
  }`;

  try {
    const resp = await fetch(GQL_URL, {
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
      const errMsg = firstGqlError(data) || `HTTP ${resp.status}`;
      console.error(
        "OFFSH_SEND_ERR",
        resp.status,
        errMsg,
        JSON.stringify({
          dst: opts.dstAllianceId,
          src: opts.srcAllianceId,
          fields: clean,
          hasBotKey: Boolean(opts.botKey),
        })
      );
      return { ok: false, err: errMsg };
    }
    const ok = Boolean(data?.data?.bankWithdraw?.id);
    return { ok, err: ok ? undefined : "No id returned" };
  } catch (e: any) {
    console.error("OFFSH_SEND_EXC", String(e?.message || e));
    return { ok: false, err: "Network/exception" };
  }
}

// ---------- Slash Command (builder) ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore banking controls")
  .addSubcommand((sc) =>
    sc
      .setName("show")
      .setDescription("Show the effective offshore configuration and controls"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("set_default")
      .setDescription("BOT ADMIN: set the global default offshore alliance id")
      .addIntegerOption((o) =>
        o
          .setName("alliance_id")
          .setDescription("Alliance ID for global default (blank to clear)")
          .setRequired(false),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("set_override")
      .setDescription("Set or clear this alliance’s offshore override")
      .addIntegerOption((o) =>
        o
          .setName("alliance_id")
          .setDescription("Alliance ID for override (blank to clear)")
          .setRequired(false),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("holdings")
      .setDescription("Show your alliance’s net holdings in your offshore (recent window, deduped)"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("send")
      .setDescription("Send from your alliance bank to the configured offshore (guided modal)"),
  );

// ---------- Slash Command: execute ----------
export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand(true);
  // Resolve alliance by guild mapping (new table first, legacy fallback)
  const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
  const legacy = i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null;
  const alliance = map
    ? await prisma.alliance.findUnique({ where: { id: map.allianceId } })
    : legacy;
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
      return i.editReply({
        content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default.",
      });
    }

    // Strategy: look at the offshore’s last N bankrecs and net what belongs to this alliance pair.
    const take = 300;
    try {
      const rows = await fetchBankrecs(offshoreAid, { limit: take });

      const A = String(alliance.id);
      const O = String(offshoreAid);
      const net: Record<string, number> = {};
      for (const k of RESOURCE_KEYS) net[k] = 0;

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

      const lines = RESOURCE_KEYS
        .map((k) => {
          const v = net[k];
          return v ? `• **${k}**: ${fmt(v)}` : null;
        })
        .filter(Boolean)
        .join("\n") || "— none in window —";

      const embed = new EmbedBuilder()
        .setTitle("📊 Offshore Holdings (net)")
        .setColor(Colors.Green)
        .setDescription(`**${alliance.name || alliance.id}** ↔ **${offshoreAid}**\nWindow: last ${take} offshore bankrecs`)
        .addFields({ name: "Net (A→O minus O→A)", value: lines })
        .setFooter({ text: `as of ${nowIso()}` });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setLabel("Re-check holdings"),
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

// Keep per-user session across modal pages
const sendSessions: Map<
  string,
  { allianceId: number; data: Record<string, number>; createdAt: number }
> = new Map();

async function openSendModal(i: Interaction, allianceId: number, page: number) {
  try {
    // Compute *fast* availability estimate to use as placeholders.
    const approxAvail = await estimateAllianceAvailableFromRecent(allianceId, 100);

    const keys = pageSlice(page);
    const total = pageCountAll();
    const modal = new ModalBuilder()
      .setCustomId(`offsh:modal:${page}`)
      .setTitle(`📤 Offshore Send (${page + 1}/${total})`);

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

    // If this was a button, call showModal on the button interaction.
    if (i.isButton()) {
      await i.showModal(modal);
    } else if ("showModal" in i) {
      // From the slash command → show modal via command interaction (discord.js types nuance)
      // @ts-ignore
      await i.showModal(modal);
    } else {
      // Fallback
      // @ts-ignore
      await i.showModal(modal);
    }

    // Initialize session if not present
    const sess = sendSessions.get((i as any).user.id) || { allianceId, data: {}, createdAt: Date.now() };
    sendSessions.set((i as any).user.id, sess);
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
    const alliance = map
      ? await prisma.alliance.findUnique({ where: { id: map.allianceId } })
      : legacy;
    if (!alliance) {
      return (i as any).reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
    }

    const sess = sendSessions.get((i as any).user.id) || { allianceId: alliance.id, data: {}, createdAt: Date.now() };

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
      if (num > 0) sess.data[k] = round2(num);
      else delete sess.data[k];
    }
    sendSessions.set((i as any).user.id, sess);

    // After modal submit, show paging controls as an ephemeral reply.
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
    const alliance = map
      ? await prisma.alliance.findUnique({ where: { id: map.allianceId } })
      : legacy;
    if (!alliance) {
      return (i as any).reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
    }

    return openSendModal(i, alliance.id, page);
  }

  // Finalize send
  if ((i as any).customId === "offsh:done") {
    const sess = sendSessions.get((i as any).user.id);
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

    // Pick a working alliance api key (newest→oldest)
    const apiKey = await getAllianceApiKeyFor(alliance.id);
    if (!apiKey) {
      return (i as any).reply({
        content: "No valid Alliance API key was found for this alliance. Use **/setup_alliance** to save one.",
        ephemeral: true,
      });
    }

    // Attempt send
    try {
      const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${(i as any).user.id}`;
      const res = await bankWithdrawAllianceToAlliance({
        srcAllianceId: alliance.id,
        dstAllianceId: offshoreAid,
        payload: sess.data,
        apiKey,
        botKey,
        note,
      });

      if (res.ok) {
        sendSessions.delete((i as any).user.id);
        return (i as any).reply({
          content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nVerify with **/offshore holdings** shortly.`,
          ephemeral: true,
        });
      } else {
        const lines = Object.entries(pickAllowedPositive(sess.data))
          .map(([k, v]) => `• ${k}: ${fmt(Number(v))}`)
          .join("\n");

        const errBlurb = res.err ? `\n\n⚠️ **API said:** ${res.err}` : "";

        const embed = new EmbedBuilder()
          .setTitle("📤 Manual offshore transfer")
          .setDescription(
            `Use your **Alliance → Alliance** banker UI to send to **Alliance ${offshoreAid}**.\nPaste the note below.${errBlurb}`,
          )
          .addFields(
            { name: "Amounts", value: lines || "—" },
            { name: "Note", value: `\`${note}\`` },
          )
          .setColor(Colors.Yellow);

        sendSessions.delete((i as any).user.id);
        return (i as any).reply({ embeds: [embed], ephemeral: true });
      }
    } catch (e) {
      console.error("[OFFSH_DONE_ERR]", e);
      return (i as any).reply({ content: "Send failed. Check logs with OFFSH_* markers.", ephemeral: true });
    }
  }

  // Show holdings button
  if ((i as any).customId === "offsh:check") {
    await (i as any).deferReply({ ephemeral: true });

    const map = (i as any).guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: (i as any).guildId } }) : null;
    const legacy = (i as any).guildId ? await prisma.alliance.findFirst({ where: { guildId: (i as any).guildId } }) : null;
    const alliance = map
      ? await prisma.alliance.findUnique({ where: { id: map.allianceId } })
      : legacy;
    if (!alliance) {
      return (i as any).editReply({ content: "This server is not linked yet. Run /setup_alliance first." });
    }

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return (i as any).editReply({
        content: "No offshore set. Use **/offshore set_override** or ask the bot admin to set a global default.",
      });
    }

    const take = 300;
    try {
      const rows = await fetchBankrecs(offshoreAid, { limit: take });

      const A = String(alliance.id);
      const O = String(offshoreAid);
      const net: Record<string, number> = {};
      for (const k of RESOURCE_KEYS) net[k] = 0;

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

      const lines = RESOURCE_KEYS
        .map((k) => {
          const v = net[k];
          return v ? `• **${k}**: ${fmt(v)}` : null;
        })
        .filter(Boolean)
        .join("\n") || "— none in window —";

      const embed = new EmbedBuilder()
        .setTitle("📊 Offshore Holdings (net)")
        .setColor(Colors.Green)
        .setDescription(`**${alliance.name || alliance.id}** ↔ **${offshoreAid}**\nWindow: last ${take} offshore bankrecs`)
        .addFields({ name: "Net (A→O minus O→A)", value: lines })
        .setFooter({ text: `as of ${nowIso()}` });

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
