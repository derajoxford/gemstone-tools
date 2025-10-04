import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { ORDER, RES_EMOJI } from "../lib/emojis";
import { open } from "../lib/crypto";

// ---------- Public exports expected elsewhere ----------
export const OFFSH_NOTE_TAG = "Gemstone Offsh";
// Keep signatures compatible with old callers (no-ops here; real logic lives elsewhere)
export async function catchUpLedgerForPair(
  _prisma: PrismaClient,
  _allianceId: number,
  _offshoreAid: number,
  _opts?: { maxLoops?: number; batchSize?: number }
): Promise<void> { /* no-op to satisfy imports */ }

export async function readLedger(
  _prisma: PrismaClient,
  _allianceId: number,
  _offshoreAid: number
): Promise<Record<string, number>> {
  // Simple read from OffshoreLedger if present
  try {
    const row: any = await _prisma.offshoreLedger.findUnique({
      where: { allianceId_offshoreId: { allianceId: _allianceId, offshoreId: _offshoreAid } }
    });
    if (!row) return {};
    const out: Record<string, number> = {};
    for (const k of ORDER) out[k] = Number(row[k as keyof typeof row] || 0);
    return out;
  } catch {
    return {};
  }
}
// -------------------------------------------------------

const prisma = new PrismaClient();

// A very small, in-memory session store (ephemeral)
type SendSess = {
  data: Record<string, number>;
  page: number;           // current page last edited
  createdAt: number;
};
const sendSessions = new Map<string, SendSess>();

// Discord modal limit is 5 inputs → chunk by 5
const PAGE_SIZE = 5;
const PAGES = Math.ceil(ORDER.length / PAGE_SIZE);
const slicePage = (page: number) => {
  const s = page * PAGE_SIZE;
  return ORDER.slice(s, s + PAGE_SIZE);
};

// ---------- Utility ----------
function parseNum(s: string): number {
  const cleaned = (s || "").replace(/[, _]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
function sumMV(rows: Record<string, number>): number {
  // Placeholder: if you later fetch market prices, multiply; for now count money+resources as numbers
  // Money dominates, so we keep the UI happy
  let total = 0;
  for (const k of ORDER) total += Number(rows[k] || 0);
  return total;
}
function fmtLine(k: string, v: number) {
  const emoji = RES_EMOJI[k as keyof typeof RES_EMOJI] ?? "";
  return `${emoji} **${k}**: ${v.toLocaleString()}`;
}

async function resolveAllianceIdFromGuild(guildId?: string | null) {
  if (!guildId) return null;

  // Try new mapping table first (supports multi-guild)
  const map = await prisma.allianceGuild.findUnique({ where: { guildId: String(guildId) } });
  if (map) {
    const a = await prisma.alliance.findUnique({ where: { id: map.allianceId } });
    if (a) return a.id;
  }
  // Fallback to legacy
  const legacy = await prisma.alliance.findFirst({ where: { guildId: String(guildId) } });
  return legacy?.id ?? null;
}

async function resolveOffshoreTargetAid(allianceId: number): Promise<number | null> {
  // 1) per-alliance override
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  if (a?.offshoreOverrideAllianceId) return a.offshoreOverrideAllianceId;

  // 2) global Setting default_offshore_aid
  const s = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
  if (s?.value && (s.value as any).aid) return Number((s.value as any).aid);

  return null;
}

async function getAllianceApiKey(allianceId: number): Promise<string | null> {
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!k) return null;
  try {
    return open(k.encryptedApiKey as any, k.nonceApi as any);
  } catch {
    return null;
  }
}

// ---------- Modal ----------
async function openSendModal(i: ButtonInteraction, page: number) {
  const modal = new ModalBuilder()
    .setCustomId(`offsh:send:modal:${page}`)
    .setTitle(`Send to Offshore (${page + 1}/${PAGES})`);

  for (const k of slicePage(page)) {
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${RES_EMOJI[k as keyof typeof RES_EMOJI] ?? ""} ${k}`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder("0");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  await i.showModal(modal);
}

// ---------- Review + Embeds ----------
function buildSummaryEmbed(allianceId: number, offshoreAid: number, data: Record<string, number>) {
  const nonZero = Object.entries(data).filter(([, v]) => Number(v) > 0);
  const fields = nonZero.length
    ? nonZero.map(([k, v]) => ({ name: k, value: `${RES_EMOJI[k as keyof typeof RES_EMOJI] ?? ""} ${Number(v).toLocaleString()}`, inline: true }))
    : [{ name: "Nothing selected", value: "—", inline: false }];

  return new EmbedBuilder()
    .setTitle("⛵ Send to Offshore — Review")
    .setDescription(
      `Alliance **${allianceId}** → Offshore **${offshoreAid}**\n` +
      `Tag: \`${OFFSH_NOTE_TAG}\``
    )
    .addFields(fields)
    .setFooter({ text: `Total (raw sum): ${sumMV(data).toLocaleString()}` })
    .setColor(Colors.Blurple);
}

function buildHoldingsEmbed(aid: number, off: number, data: Record<string, number>) {
  const nonZero = Object.entries(data).filter(([, v]) => Number(v) > 0);
  const lines = nonZero.length
    ? nonZero.map(([k, v]) => fmtLine(k, Number(v))).join("\n")
    : "— none —";

  return new EmbedBuilder()
    .setTitle(`📊 Offshore Holdings — ${aid}`)
    .setDescription(`Held in offshore **${off}** • as of ${new Date().toISOString()}`)
    .addFields({ name: "Resources", value: lines })
    .setColor(Colors.Gold);
}

// ---------- PnW GraphQL ----------
async function pnwAllianceToAllianceWithdraw(opts: {
  apiKey: string;
  botKey: string;
  receiverAllianceId: number;
  payload: Record<string, number>;
  note?: string;
}): Promise<{ ok: boolean; status: number; body: any }> {
  // GraphQL mutation; receiver_type = 2 (alliance)
  const resourceArgs = Object.entries(opts.payload)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k}:${Number(v)}`);

  const extra = opts.note ? `, note:${JSON.stringify(opts.note)}` : "";
  const q = `mutation{
    bankWithdraw(receiver:${opts.receiverAllianceId}, receiver_type:2, ${resourceArgs.join(",")}${extra}) { id }
  }`;

  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(opts.apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": opts.apiKey,
      "X-Bot-Key": opts.botKey,
    },
    body: JSON.stringify({ query: q }),
  });
  let body: any = {};
  try { body = await res.json(); } catch { body = {}; }
  const ok = res.ok && !body?.errors && body?.data?.bankWithdraw;
  return { ok, status: res.status, body };
}

// ---------- Button / Modal handlers (exported to index.ts) ----------
export async function handleButton(i: ButtonInteraction) {
  try {
    // Buttons:
    // offsh:send:open:<page>
    // offsh:send:review
    // offsh:send:confirm
    // offsh:send:cancel

    if (i.customId.startsWith("offsh:send:open:")) {
      const m = i.customId.match(/^offsh:send:open:(\d+)$/);
      const page = m ? Math.max(0, parseInt(m[1]!, 10)) : 0;
      // init session if missing
      if (!sendSessions.get(i.user.id)) {
        sendSessions.set(i.user.id, { data: {}, page, createdAt: Date.now() });
      }
      return openSendModal(i, page);
    }

    if (i.customId === "offsh:send:cancel") {
      sendSessions.delete(i.user.id);
      return i.reply({ content: "❎ Cancelled.", ephemeral: true });
    }

    if (i.customId === "offsh:send:review") {
      const allianceId = await resolveAllianceIdFromGuild(i.guildId);
      if (!allianceId) return i.reply({ content: "This server is not linked to an alliance. Run /setup_alliance first.", ephemeral: true });

      const offshoreAid = await resolveOffshoreTargetAid(allianceId);
      if (!offshoreAid) return i.reply({ content: "No offshore target configured. Set Alliance override or Setting `default_offshore_aid`.", ephemeral: true });

      const sess = sendSessions.get(i.user.id) || { data: {}, page: 0, createdAt: Date.now() };
      const embed = buildSummaryEmbed(allianceId, offshoreAid, sess.data);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("offsh:send:confirm").setStyle(ButtonStyle.Success).setEmoji("✅").setLabel("Confirm"),
        new ButtonBuilder().setCustomId("offsh:send:open:0").setStyle(ButtonStyle.Secondary).setEmoji("📝").setLabel("Edit"),
        new ButtonBuilder().setCustomId("offsh:send:cancel").setStyle(ButtonStyle.Danger).setEmoji("✖️").setLabel("Cancel"),
      );
      return i.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (i.customId === "offsh:send:confirm") {
      const allianceId = await resolveAllianceIdFromGuild(i.guildId);
      if (!allianceId) return i.reply({ content: "This server is not linked to an alliance. Run /setup_alliance first.", ephemeral: true });

      const offshoreAid = await resolveOffshoreTargetAid(allianceId);
      if (!offshoreAid) return i.reply({ content: "No offshore target configured. Set Alliance override or Setting `default_offshore_aid`.", ephemeral: true });

      const sess = sendSessions.get(i.user.id);
      if (!sess || !Object.values(sess.data).some(v => Number(v) > 0)) {
        return i.reply({ content: "Nothing to send — enter some amounts first.", ephemeral: true });
      }

      const apiKey = await getAllianceApiKey(allianceId);
      const botKey = process.env.PNW_BOT_KEY || "";

      if (!apiKey || !botKey) {
        return i.reply({ content: "Missing alliance API key (run /setup_alliance) or PNW_BOT_KEY in .env.", ephemeral: true });
      }

      const note = `${OFFSH_NOTE_TAG} • A:${allianceId}→${offshoreAid} • by ${i.user.id}`;
      const { ok, status, body } = await pnwAllianceToAllianceWithdraw({
        apiKey, botKey, receiverAllianceId: offshoreAid, payload: sess.data, note
      });

      if (!ok) {
        console.error("[OFFSH_SEND_ERR]", status, JSON.stringify(body));
        const msg = body?.errors?.[0]?.message || `HTTP ${status}`;
        return i.reply({ content: `❌ Send failed: ${msg}`, ephemeral: true });
      }

      // success UX
      const embed = new EmbedBuilder()
        .setTitle("✅ Sent to Offshore")
        .setDescription(`Alliance **${allianceId}** → offshore **${offshoreAid}**`)
        .addFields(
          ...Object.entries(sess.data)
            .filter(([, v]) => Number(v) > 0)
            .map(([k, v]) => ({ name: k, value: `${RES_EMOJI[k as keyof typeof RES_EMOJI] ?? ""} ${Number(v).toLocaleString()}`, inline: true }))
        )
        .setFooter({ text: `Tag: ${OFFSH_NOTE_TAG}` })
        .setColor(Colors.Green);

      sendSessions.delete(i.user.id);
      return i.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    console.error("[OFFSH_BTN_ERR]", err);
    try { await i.reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
}

export async function handleModal(i: any) {
  try {
    // offsh:send:modal:<page>
    if (!String(i.customId).startsWith("offsh:send:modal:")) return;
    const m = String(i.customId).match(/^offsh:send:modal:(\d+)$/);
    const page = m ? Math.max(0, parseInt(m[1]!, 10)) : 0;

    const sess = sendSessions.get(i.user.id) || { data: {}, page, createdAt: Date.now() };

    for (const k of slicePage(page)) {
      const raw = (i.fields.getTextInputValue(k) || "").trim();
      if (!raw) { delete sess.data[k]; continue; }
      const num = parseNum(raw);
      if (!Number.isFinite(num) || num < 0) {
        return i.reply({ content: `Invalid number for ${k}.`, ephemeral: true });
      }
      sess.data[k] = num;
    }
    sess.page = page;
    sendSessions.set(i.user.id, sess);

    // Build a compact “saved so far” + quick controls
    const summary = Object.entries(sess.data)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${RES_EMOJI[k as keyof typeof RES_EMOJI] ?? ""}${k}: ${Number(v).toLocaleString()}`)
      .join("  •  ") || "— none yet —";

    const buttons: ButtonBuilder[] = [];
    if (page > 0) buttons.push(new ButtonBuilder().setCustomId(`offsh:send:open:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel("◀ Prev"));
    if (page < PAGES - 1) buttons.push(new ButtonBuilder().setCustomId(`offsh:send:open:${page + 1}`).setStyle(ButtonStyle.Secondary).setLabel("Next ▶"));
    buttons.push(new ButtonBuilder().setCustomId("offsh:send:review").setStyle(ButtonStyle.Success).setEmoji("✅").setLabel("Review / Submit Now"));
    buttons.push(new ButtonBuilder().setCustomId("offsh:send:cancel").setStyle(ButtonStyle.Danger).setLabel("Cancel"));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
    return i.reply({ content: `Saved so far:\n${summary}`, components: [row], ephemeral: true });
  } catch (err) {
    console.error("[OFFSH_MODAL_ERR]", err);
    try { await i.reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
}
