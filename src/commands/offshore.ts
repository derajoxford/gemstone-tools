// src/commands/offshore.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { ORDER, RES_EMOJI } from "../lib/emojis";
import { open } from "../lib/crypto.js";
// Optional: if you want to advance the ledger before showing holdings
import { catchUpLedgerForPair } from "../lib/offshore_ledger";

const prisma = new PrismaClient();

// ---------- config ----------
const SEND_PAGE_SIZE = 4; // 4 inputs per modal page (Discord max = 5; we keep 1 slot free)
const SEND_NOTE_ON_LAST_PAGE = true;
const NOTE_KEY = "__note__";

// simple per-user session for the send flow
type SendSession = {
  sourceAid: number;
  offshoreAid: number;
  data: Record<string, number>;
  note?: string;
  createdAt: number;
};
const sendSessions = new Map<string, SendSession>();

// ---------- helpers ----------
function fmtLine(k: string, v: number) {
  return `${RES_EMOJI[k] ?? ""} ${k}: ${Number(v).toLocaleString()}`;
}

function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[, _]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

async function findAllianceForGuild(guildId?: string) {
  if (!guildId) return null;
  const map = await prisma.allianceGuild.findUnique({ where: { guildId } });
  if (map) {
    const a = await prisma.alliance.findUnique({ where: { id: map.allianceId } });
    if (a) return a;
  }
  return await prisma.alliance.findFirst({ where: { guildId } });
}

async function resolveOffshoreAidForAlliance(aid: number): Promise<number | null> {
  const a = await prisma.alliance.findUnique({ where: { id: aid } });
  if (a?.offshoreOverrideAllianceId) return a.offshoreOverrideAllianceId;
  const setting = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
  const v = (setting?.value as any)?.aid;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sliceKeys(page: number) {
  const s = page * SEND_PAGE_SIZE;
  return ORDER.slice(s, s + SEND_PAGE_SIZE);
}

function pageCount() {
  return Math.ceil(ORDER.length / SEND_PAGE_SIZE);
}

function buildSendSummary(sess: SendSession) {
  const lines = Object.entries(sess.data)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => fmtLine(k, v));
  return lines.join(" · ") || "— none —";
}

// ---------- show holdings ----------
async function showHoldings(i: ChatInputCommandInteraction) {
  const alliance = await findAllianceForGuild(i.guildId ?? undefined);
  if (!alliance) return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });

  const offshoreAid = await resolveOffshoreAidForAlliance(alliance.id);
  if (!offshoreAid) return i.reply({ content: "No offshore alliance configured.", ephemeral: true });

  // Ensure ledger is caught up quickly (best effort)
  try { await catchUpLedgerForPair(prisma, alliance.id, offshoreAid); } catch {}

  const ledger = await prisma.offshoreLedger.findUnique({
    where: { allianceId_offshoreId: { allianceId: alliance.id, offshoreId: offshoreAid } },
  });

  const embed = new EmbedBuilder()
    .setTitle(`📊 Offshore Holdings — ${alliance.id}`)
    .setDescription(`${alliance.id} held in offshore ${offshoreAid}\nRunning balance (bot-tagged only)`)
    .setColor(Colors.Blurple);

  if (ledger) {
    const entries: string[] = [];
    for (const k of ORDER) {
      const v = Number((ledger as any)[k] || 0);
      if (v > 0) entries.push(fmtLine(k, v));
    }
    embed.addFields({ name: "Balances", value: entries.join("\n") || "— none —", inline: false });
  } else {
    embed.addFields({ name: "Balances", value: "— none —", inline: false });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("offsh:refresh").setStyle(ButtonStyle.Secondary).setLabel("Refresh Now"),
    new ButtonBuilder().setCustomId("offsh:send:open:0").setStyle(ButtonStyle.Primary).setLabel("Send to Offshore"),
  );

  await i.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ---------- modal flow (all 12 resources, paged) ----------
async function openSendModal(i: ButtonInteraction, page: number) {
  const alliance = await findAllianceForGuild(i.guildId ?? undefined);
  if (!alliance) return i.reply({ content: "No alliance linked here.", ephemeral: true });

  const offshoreAid = await resolveOffshoreAidForAlliance(alliance.id);
  if (!offshoreAid) return i.reply({ content: "No offshore alliance configured.", ephemeral: true });

  // init session if missing
  if (!sendSessions.has(i.user.id)) {
    sendSessions.set(i.user.id, { sourceAid: alliance.id, offshoreAid, data: {}, createdAt: Date.now() });
  }
  const sess = sendSessions.get(i.user.id)!;

  // modal
  const total = pageCount();
  const keys = sliceKeys(page);
  const modal = new ModalBuilder().setCustomId(`offsh:send:modal:${page}`).setTitle(`Send to Offshore (${page + 1}/${total})`);

  for (const k of keys) {
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${RES_EMOJI[k] ?? ""} ${k} (leave blank for 0)`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(sess.data[k] ? String(sess.data[k]) : "0");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  // add note field on the last page (optional)
  if (SEND_NOTE_ON_LAST_PAGE && page === total - 1) {
    const note = new TextInputBuilder()
      .setCustomId(NOTE_KEY)
      .setLabel("Note (optional)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(sess.note ?? "");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(note));
  }

  await i.showModal(modal);
}

async function handleSendModal(i: any) {
  const m = String(i.customId).match(/^offsh:send:modal:(\d+)$/);
  if (!m) return;
  const page = Number(m[1]);
  const total = pageCount();

  const sess = sendSessions.get(i.user.id);
  if (!sess) return i.reply({ content: "Session expired. Press **Send to Offshore** again.", ephemeral: true });

  // collect this page
  const keys = sliceKeys(page);
  for (const k of keys) {
    const raw = (i.fields.getTextInputValue(k) || "").trim();
    if (!raw) { delete sess.data[k]; continue; }
    const num = parseNum(raw);
    if (!Number.isFinite(num) || num < 0) {
      return i.reply({ content: `Invalid number for ${k}.`, ephemeral: true });
    }
    sess.data[k] = num;
  }
  if (SEND_NOTE_ON_LAST_PAGE && page === total - 1) {
    const noteRaw = (i.fields.getTextInputValue(NOTE_KEY) || "").trim();
    sess.note = noteRaw || undefined;
  }
  sendSessions.set(i.user.id, sess);

  // build nav buttons
  const btns: ButtonBuilder[] = [];
  if (page > 0) btns.push(new ButtonBuilder().setCustomId(`offsh:send:open:${page - 1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary));
  if (page < total - 1) {
    btns.push(new ButtonBuilder().setCustomId(`offsh:send:open:${page + 1}`).setLabel(`Next (${page + 2}/${total}) ▶`).setStyle(ButtonStyle.Primary));
  } else {
    btns.push(new ButtonBuilder().setCustomId("offsh:send:review").setLabel("Review").setStyle(ButtonStyle.Success));
  }
  btns.push(new ButtonBuilder().setCustomId("offsh:send:cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
  const summary = buildSendSummary(sess);
  await i.reply({ content: `Saved so far:\n${summary}`, components: [row], ephemeral: true });
}

async function showSendReview(i: ButtonInteraction) {
  const sess = sendSessions.get(i.user.id);
  if (!sess) return i.reply({ content: "Session expired. Press **Send to Offshore** again.", ephemeral: true });

  const summary = buildSendSummary(sess);
  const embed = new EmbedBuilder()
    .setTitle(`Send to Offshore — Review`)
    .setDescription(`From **${sess.sourceAid}** → **${sess.offshoreAid}**`)
    .addFields({ name: "Amounts", value: summary || "— none —" })
    .setColor(Colors.Blurple);

  if (sess.note) embed.addFields({ name: "Note", value: sess.note });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("offsh:send:confirm").setStyle(ButtonStyle.Success).setLabel("Confirm"),
    new ButtonBuilder().setCustomId("offsh:send:cancel").setStyle(ButtonStyle.Danger).setLabel("Cancel"),
  );

  await i.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// minimal GQL call to PnW to send A->A
async function sendAllianceToAlliance(opts: {
  sourceAid: number;
  offshoreAid: number;
  payload: Record<string, number>;
  note?: string;
}): Promise<boolean> {
  // pull latest API key for the source alliance
  const alliance = await prisma.alliance.findUnique({
    where: { id: opts.sourceAid },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const apiKeyEnc = alliance?.keys[0];
  const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
  const botKey = process.env.PNW_BOT_KEY || "";

  if (!apiKey || !botKey) return false;

  const fields = Object.entries(opts.payload)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k}:${Number(v)}`);
  if (opts.note) fields.push(`note:${JSON.stringify(opts.note)}`);

  const q = `mutation{
    bankWithdraw(receiver:${opts.offshoreAid}, receiver_type:2, ${fields.join(",")}) { id }
  }`;

  const fetchFn: any = (globalThis as any).fetch;
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Bot-Key": botKey,
    },
    body: JSON.stringify({ query: q }),
  }).catch(() => null);

  if (!res) return false;
  let data: any = {};
  try { data = await res.json(); } catch {}

  if (!res.ok || data?.errors) {
    console.error("[OFFSH_SEND_ERR]", res.status, JSON.stringify(data));
    return false;
  }
  return Boolean(data?.data?.bankWithdraw?.id);
}

async function confirmSend(i: ButtonInteraction) {
  const sess = sendSessions.get(i.user.id);
  if (!sess) return i.reply({ content: "Session expired. Press **Send to Offshore** again.", ephemeral: true });

  const payload = Object.fromEntries(
    Object.entries(sess.data).filter(([, v]) => Number(v) > 0)
  );

  if (!Object.keys(payload).length) {
    return i.reply({ content: "Nothing to send — all zeros.", ephemeral: true });
  }

  const ok = await sendAllianceToAlliance({
    sourceAid: sess.sourceAid,
    offshoreAid: sess.offshoreAid,
    payload,
    note: sess.note || undefined,
  });

  if (ok) {
    sendSessions.delete(i.user.id);
    await i.reply({ content: "✅ Sent to offshore.", ephemeral: true });
  } else {
    await i.reply({ content: "⚠️ Send failed. Check API/Bot keys and try again.", ephemeral: true });
  }
}

function cancelSend(i: ButtonInteraction) {
  sendSessions.delete(i.user.id);
  return i.reply({ content: "Canceled.", ephemeral: true });
}

// ---------- exports required by index.ts ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore tools")
  .addSubcommand((s) => s.setName("show").setDescription("Show offshore holdings"));

export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand() || "show";
  if (sub === "show") return showHoldings(i);
}

// Buttons & Modals are routed by index.ts via customId prefix "offsh:"
export async function handleButton(i: ButtonInteraction) {
  try {
    const id = String(i.customId);

    if (id === "offsh:refresh") {
      // re-show to refresh
      const fake = i as unknown as ChatInputCommandInteraction;
      return showHoldings(fake);
    }

    if (id.startsWith("offsh:send:open")) {
      const m = id.match(/^offsh:send:open:(\d+)$/);
      const page = m ? Number(m[1]) : 0;
      return openSendModal(i, page);
    }

    if (id === "offsh:send:review") return showSendReview(i);
    if (id === "offsh:send:confirm") return confirmSend(i);
    if (id === "offsh:send:cancel") return cancelSend(i);
  } catch (err) {
    console.error("[OFFSH_BTN_ERR]", err);
    try { await i.reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
}

export async function handleModal(i: any) {
  try {
    return handleSendModal(i);
  } catch (err) {
    console.error("[OFFSH_MODAL_ERR]", err);
    try { await i.reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
}
