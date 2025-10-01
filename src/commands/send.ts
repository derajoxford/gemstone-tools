// src/commands/send.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { ORDER, RES_EMOJI } from "../lib/emojis.js";

const prisma = new PrismaClient();

type Kind = "NATION" | "ALLIANCE";
type SendMeta = { kind: Kind; recipientId: number; note?: string | null };

const SEND_PAGE_SIZE = 5;
const pagesCount = Math.ceil(ORDER.length / SEND_PAGE_SIZE);
const sliceKeys = (page: number) => {
  const s = page * SEND_PAGE_SIZE;
  return ORDER.slice(s, s + SEND_PAGE_SIZE);
};

function parseNumericIdFromInput(input: string): number | null {
  const raw = input.trim();
  const m = raw.match(/id\s*=\s*(\d+)/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const digits = raw.replace(/[^\d]/g, "");
  if (digits) {
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
function nice(n: number) {
  return n.toLocaleString("en-US");
}
function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[, _]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

async function getAllianceByGuild(guildId?: string | null) {
  if (!guildId) return null;
  return prisma.alliance.findFirst({
    where: { guildId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
}
async function getMember(allianceId: number, discordId: string) {
  return prisma.member.findFirst({
    where: { allianceId, discordId },
    include: { balance: true },
  });
}
async function ensureSafekeeping(memberId: number) {
  let sk = await prisma.safekeeping.findFirst({ where: { memberId } });
  if (!sk) {
    sk = await prisma.safekeeping.create({
      data: {
        memberId,
        money: 0, food: 0, coal: 0, oil: 0, uranium: 0,
        lead: 0, iron: 0, bauxite: 0, gasoline: 0,
        munitions: 0, steel: 0, aluminum: 0,
      },
    });
  }
  return sk;
}

/** ephemeral per-user session for multi-page + confirm */
const sessions = new Map<string, {
  meta: SendMeta;
  data: Record<string, number>;
  createdAt: number;
}>();

// --- minimal bankWithdraw ---
async function pnwBankWithdraw(opts: {
  apiKey: string;
  botKey: string;
  receiverId: number;
  receiverType: 1 | 2; // 1 = Nation, 2 = Alliance
  resources: Record<string, number>; // money + others
  note?: string;
}): Promise<boolean> {
  const fields: string[] = Object.entries(opts.resources)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k}:${Math.floor(Number(v))}`);
  if (opts.note) fields.push(`note:${JSON.stringify(opts.note)}`);
  const query = `mutation{ bankWithdraw(receiver:${opts.receiverId}, receiver_type:${opts.receiverType}, ${fields.join(",")}) { id } }`;
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(opts.apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": opts.apiKey,
      "X-Bot-Key": opts.botKey,
    },
    body: JSON.stringify({ query }),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || (data as any)?.errors) {
    console.error("SEND_AUTOPAY_ERR", res.status, JSON.stringify(data));
    return false;
  }
  return Boolean((data as any)?.data?.bankWithdraw);
}

// ------------------ slash command ------------------
export const data = new SlashCommandBuilder()
  .setName("send")
  .setDescription("Send from your Safekeeping: select Nation or Alliance, fill multi-page modal, then confirm.");

export async function execute(i: ChatInputCommandInteraction) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("send:pick:nation").setLabel("Send to Nation").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("send:pick:alliance").setLabel("Send to Alliance").setStyle(ButtonStyle.Secondary),
  );
  await i.reply({
    content: "Choose where to send funds/resources from your Safekeeping:",
    components: [row],
    ephemeral: true,
  });
}

// ------------------ buttons (picker / paging / review / confirm) ------------------
export async function handleButton(i: ButtonInteraction) {
  // Picker → first modal (page 0) collects amounts for first slice; also asks recipient + note ONCE
  if (i.customId === "send:pick:nation" || i.customId === "send:pick:alliance") {
    const kind: Kind = i.customId.endsWith("nation") ? "NATION" : "ALLIANCE";
    return openPageModal(i, kind, 0, true);
  }

  // Page navigation: send:open:<page>
  if (i.customId.startsWith("send:open:")) {
    const parts = i.customId.split(":");
    const page = Math.max(0, Number(parts[2] || 0) || 0);
    // pull kind from existing session
    const sess = sessions.get(i.user.id);
    const kind: Kind = sess?.meta?.kind || "NATION";
    return openPageModal(i, kind, page, false);
  }

  // Review (show confirmation)
  if (i.customId === "send:review") {
    return showConfirm(i);
  }

  // Confirm → create request + post bankers
  if (i.customId === "send:confirm") {
    return finalizeAndPost(i);
  }

  // Cancel → drop session
  if (i.customId === "send:cancel") {
    sessions.delete(i.user.id);
    return i.update({ content: "❎ Send canceled.", components: [], embeds: [] }).catch(() => {});
  }
}

// Build and show a modal for a given page
async function openPageModal(i: ButtonInteraction, kind: Kind, page: number, includeRecipientFields: boolean) {
  const alliance = await getAllianceByGuild(i.guildId);
  if (!alliance) return i.reply({ ephemeral: true, content: "This server is not linked yet. Run /setup_alliance first." });

  const member = await getMember(alliance.id, i.user.id);
  if (!member) return i.reply({ ephemeral: true, content: "❌ You’re not linked yet. Use /link_nation first." });

  await ensureSafekeeping(member.id);
  const bal: any = member.balance as any;

  const keys = sliceKeys(page);
  const modal = new ModalBuilder()
    .setCustomId(`send:modal:${page}`)
    .setTitle(`Send (${page + 1}/${pagesCount}) — ${kind === "NATION" ? "Nation" : "Alliance"}`);

  // On the FIRST page, collect recipient + note once
  if (includeRecipientFields) {
    const recip = new TextInputBuilder()
      .setCustomId("send:recipient")
      .setLabel(kind === "NATION" ? "Nation ID or Nation Link" : "Alliance ID or Alliance Link")
      .setPlaceholder(kind === "NATION" ? "123456 or https://politicsandwar.com/nation/id=123456"
                                        : "10304 or https://politicsandwar.com/alliance/id=10304")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);

    const note = new TextInputBuilder()
      .setCustomId("send:note").setLabel("Note (optional)")
      .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(recip),
      new ActionRowBuilder<TextInputBuilder>().addComponents(note),
    );
  }

  // Amount inputs for this page’s resources
  for (const k of keys) {
    const avail = Number(bal?.[k] || 0);
    const input = new TextInputBuilder()
      .setCustomId(`amt:${k}`)
      .setLabel(`${RES_EMOJI[k] ?? ''} ${k} (avail: ${avail.toLocaleString()})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder('0');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  await i.showModal(modal);
}

// ------------------ modal submit (per page) ------------------
export async function handleModal(i: ModalSubmitInteraction) {
  if (!i.customId.startsWith("send:modal:")) return;
  const page = Number(i.customId.split(":")[2] || 0);

  const alliance = await getAllianceByGuild(i.guildId);
  if (!alliance) return i.reply({ ephemeral: true, content: "This server is not linked yet. Run /setup_alliance first." });

  const member = await getMember(alliance.id, i.user.id);
  if (!member) return i.reply({ ephemeral: true, content: "❌ You’re not linked yet. Use /link_nation first." });

  const bal: any = member.balance as any;

  // Session or initialize
  let sess = sessions.get(i.user.id);
  if (!sess) {
    // determine kind from modal title
    const isNation = i.title.toLowerCase().includes("nation");
    sess = {
      meta: { kind: isNation ? "NATION" : "ALLIANCE", recipientId: 0, note: null },
      data: {},
      createdAt: Date.now(),
    };
  }

  // On page 0, read recipient + note once
  if (page === 0 && i.fields.getTextInputValue("send:recipient") !== undefined) {
    const rawRecipient = (i.fields.getTextInputValue("send:recipient") || "").trim();
    const rid = parseNumericIdFromInput(rawRecipient);
    if (!rid) {
      return i.reply({
        ephemeral: true,
        content: sess.meta.kind === "NATION"
          ? "❌ Please provide a valid **Nation** ID or nation link containing `id=...`."
          : "❌ Please provide a valid **Alliance** ID or alliance link containing `id=...`.",
      });
    }
    sess.meta.recipientId = rid;
    const note = (i.fields.getTextInputValue("send:note") || "").trim();
    sess.meta.note = note || null;
  }

  // Collect this page’s amounts
  const keys = sliceKeys(page);
  for (const k of keys) {
    const raw = (i.fields.getTextInputValue(`amt:${k}`) || '').trim();
    if (raw === '') { delete sess.data[k]; continue; }
    const num = parseNum(raw);
    if (!Number.isFinite(num) || num < 0) {
      return i.reply({ content: `Invalid number for ${k}.`, ephemeral: true });
    }
    const avail = Number(bal?.[k] || 0);
    if (num > avail) {
      return i.reply({ content: `Requested ${num.toLocaleString()} ${k}, but only ${avail.toLocaleString()} available.`, ephemeral: true });
    }
    if (num > 0) sess.data[k] = num; else delete sess.data[k];
  }
  sessions.set(i.user.id, sess);

  // Build nav buttons
  const btns: ButtonBuilder[] = [];
  if (page > 0) btns.push(new ButtonBuilder().setCustomId(`send:open:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel(`◀ Prev (${page}/${pagesCount})`));
  if (page < pagesCount - 1) btns.push(new ButtonBuilder().setCustomId(`send:open:${page + 1}`).setStyle(ButtonStyle.Primary).setLabel(`Next (${page + 2}/${pagesCount}) ▶`));
  btns.push(new ButtonBuilder().setCustomId('send:review').setStyle(ButtonStyle.Success).setLabel('Review & Confirm'));

  const summary = Object.entries(sess.data)
    .map(([k, v]) => `${RES_EMOJI[k as any] ?? ''}${k}: ${Number(v).toLocaleString()}`)
    .join(' · ') || '— none yet —';

  await i.reply({
    ephemeral: true,
    content: `Saved so far for **${sess.meta.kind}** → **ID ${sess.meta.recipientId || '—'}**\n${summary}`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...btns)],
  });
}

// ------------------ confirmation screen ------------------
async function showConfirm(i: ButtonInteraction) {
  const sess = sessions.get(i.user.id);
  if (!sess || !sess.meta?.recipientId) {
    return i.reply({ ephemeral: true, content: "Se
