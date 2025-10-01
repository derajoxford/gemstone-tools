import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { ORDER, RES_EMOJI } from "../lib/emojis.js";
import { open } from "../lib/crypto.js";

// ---- Prisma
const prisma = new PrismaClient();

// ---- Local helpers
function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[, _]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
function fmtLine(k: string, v: number) {
  return `${RES_EMOJI[k as keyof typeof RES_EMOJI] || ""} **${k}**: ${v.toLocaleString()}`;
}
function onlyResourceEntries(obj: Record<string, any>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (ORDER.includes(k as any) && Number(v) > 0) out[k] = Number(v);
  }
  return out;
}
function httpsOrNull(url?: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch { return null; }
}

// ---- Session (per user)
type DestType = "NATION" | "ALLIANCE";
type SendSession = {
  destType: DestType | null;
  targetId: number | null;
  targetLink?: string | null;
  targetName?: string | null; // resolved name
  targetFlag?: string | null; // resolved https flag url
  note?: string | null;
  payload: Record<string, number>;
  createdAt: number;
};
const sendSessions = new Map<string, SendSession>();

// ---- Paging
const SEND_PAGE_SIZE = 5;           // resource inputs per modal page (pages > 0)
const SEND_PAGE_SIZE_FIRST = 3;     // resource inputs on page 0 (target+note count toward the 5-component modal cap)

function sendPageCountAll() { return Math.ceil(ORDER.length / SEND_PAGE_SIZE); }
function sendSliceAll(page: number, firstPage: boolean) {
  if (firstPage) return ORDER.slice(0, SEND_PAGE_SIZE_FIRST);
  const s = page * SEND_PAGE_SIZE;
  return ORDER.slice(s, s + SEND_PAGE_SIZE);
}

// ---- Extract ID from "id=12345" style links or raw numbers
function extractId(input: string): number | null {
  if (!input) return null;
  const trimmed = input.trim();

  const all = Array.from(trimmed.matchAll(/\d{2,9}/g)).map(m => m[0]);
  if (all.length) {
    const id = Number(all[all.length - 1]);
    if (Number.isInteger(id) && id > 0) return id;
  }

  const num = Number(trimmed);
  if (Number.isInteger(num) && num > 0) return num;

  return null;
}

// ---- PnW GraphQL lookup (name + flag) — best-effort
async function lookupRecipient(
  destType: DestType,
  id: number,
  guildId?: string | null
): Promise<{ name: string | null; flag: string | null }> {
  try {
    // get API key: guild alliance key > env default
    let apiKey = process.env.PNW_DEFAULT_API_KEY || "";

    if (guildId) {
      const alliance = await prisma.alliance.findFirst({
        where: { guildId: guildId || "" },
        include: { keys: { orderBy: { id: "desc" }, take: 1 } }
      });
      const apiKeyEnc = alliance?.keys?.[0];
      if (apiKeyEnc) apiKey = open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) || apiKey;
    }
    if (!apiKey) return { name: null, flag: null };

    const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
    let q = "";
    if (destType === "NATION") {
      // fields may vary slightly by API version; try common ones
      q = `query{ nation(id:${id}){ nation_name name flag } }`;
    } else {
      q = `query{ alliance(id:${id}){ name flag } }`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ query: q })
    });

    const data = await res.json().catch(() => ({} as any));
    if (!res.ok || (data as any)?.errors) return { name: null, flag: null };

    if (destType === "NATION") {
      const n = (data as any)?.data?.nation;
      const name = n?.nation_name || n?.name || null;
      const flag = httpsOrNull(n?.flag || null);
      return { name, flag };
    } else {
      const a = (data as any)?.data?.alliance;
      const name = a?.name || null;
      const flag = httpsOrNull(a?.flag || null);
      return { name, flag };
    }
  } catch {
    return { name: null, flag: null };
  }
}

// ---- PnW bankWithdraw for both Nation and Alliance
async function pnwSend(opts: {
  apiKey: string; botKey: string;
  destType: DestType;
  receiverId: number;
  payload: Record<string, number>;
  note?: string | null;
}): Promise<boolean> {
  const fields: string[] = Object.entries(opts.payload)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k}:${Number(v)}`);

  if (opts.note && String(opts.note).length) {
    fields.push(`note:${JSON.stringify(String(opts.note))}`);
  }

  const rtype = opts.destType === "NATION" ? 1 : 2;
  const q = `mutation{
    bankWithdraw(receiver:${opts.receiverId}, receiver_type:${rtype}, ${fields.join(",")}) { id }
  }`;

  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(opts.apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": opts.apiKey,
      "X-Bot-Key": opts.botKey,
    },
    body: JSON.stringify({ query: q }),
  });

  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || (data as any)?.errors) {
    console.error("[pnwSend] API error", res.status, JSON.stringify(data));
  }
  return res.ok && !(data as any)?.errors && (data as any)?.data?.bankWithdraw;
}

// =====================
// Slash Command: /send
// =====================
export const data = new SlashCommandBuilder()
  .setName("send")
  .setDescription("Send from your safekeeping to a Nation or Alliance (with banker approval)");

export async function execute(i: ChatInputCommandInteraction) {
  // Start fresh session
  sendSessions.set(i.user.id, {
    destType: null,
    targetId: null,
    targetLink: null,
    targetName: null,
    targetFlag: null,
    note: null,
    payload: {},
    createdAt: Date.now(),
  });

  const embed = new EmbedBuilder()
    .setTitle("💎 Send from Safekeeping")
    .setDescription("Pick a recipient type to start. You’ll enter the Nation/Alliance **ID or link**, select resources on pages (inputs show your available amounts), add a note, then **Review & Confirm** to send for banker approval.")
    .setColor(Colors.Blurple);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("send:pick:nation").setStyle(ButtonStyle.Primary).setEmoji("🏳️").setLabel("Send to Nation"),
    new ButtonBuilder().setCustomId("send:pick:alliance").setStyle(ButtonStyle.Secondary).setEmoji("🏛️").setLabel("Send to Alliance"),
  );

  await i.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// =====================
// Button router
// =====================
export async function handleButton(i: ButtonInteraction) {
  if (!i.inGuild()) return i.reply({ ephemeral: true, content: "Guild only." });

  // Ensure session
  const sess = sendSessions.get(i.user.id) || {
    destType: null, targetId: null, targetLink: null, targetName: null, targetFlag: null, payload: {}, note: null, createdAt: Date.now()
  };
  sendSessions.set(i.user.id, sess);

  // Pick Nation/Alliance (opens first modal page)
  if (i.customId === "send:pick:nation" || i.customId === "send:pick:alliance") {
    const dest: DestType = i.customId.endsWith("nation") ? "NATION" : "ALLIANCE";
    sess.destType = dest;
    sendSessions.set(i.user.id, sess);
    return openModalPage(i, 0, true); // page 0, include target + note + avail labels
  }

  // Open resource page N
  if (i.customId.startsWith("send:open:")) {
    const page = Math.max(0, parseInt(i.customId.split(":")[2] || "0", 10));
    return openModalPage(i, page, false); // pages >0, no target field, avail labels
  }

  if (i.customId === "send:review") {
    return handleReview(i);
  }

  if (i.customId === "send:confirm") {
    return handleConfirm(i);
  }

  if (i.customId === "send:cancel") {
    sendSessions.delete(i.user.id);
    return i.reply({ ephemeral: true, content: "❎ Send canceled." });
  }

  return i.reply({ ephemeral: true, content: "Something went wrong. Try again." });
}

// =====================
// Modal router
// =====================
export async function handleModal(i: any) {
  if (!String(i.customId).startsWith("send:modal:")) return;

  const sess = sendSessions.get(i.user.id);
  if (!sess) return i.reply({ ephemeral: true, content: "Session expired. Start again with **/send**." });

  const page = Math.max(0, parseInt(String(i.customId).split(":")[2] || "0", 10));
  const keys = sendSliceAll(page, page === 0);

  // First page: target + note + resolve name & flag (best-effort)
  if (page === 0) {
    const targetRaw = (i.fields.getTextInputValue("target") || "").trim();
    const noteRaw = (i.fields.getTextInputValue("note") || "").trim();
    const id = extractId(targetRaw);

    if (!sess.destType) {
      return i.reply({ ephemeral: true, content: "Select a recipient type first (Send to Nation or Send to Alliance)." });
    }
    if (!id) {
      return i.reply({ ephemeral: true, content: "Please enter a valid **ID** or a proper **link** that contains an ID." });
    }
    sess.targetId = id;
    sess.targetLink = targetRaw || null;
    sess.note = noteRaw || null;

    // attempt lookup
    try {
      const { name, flag } = await lookupRecipient(sess.destType, id, i.guildId);
      if (name) sess.targetName = name;
      if (flag) sess.targetFlag = flag;
    } catch { /* ignore */ }
  }

  // Parse resource inputs for this page
  for (const k of keys) {
    const raw = (i.fields.getTextInputValue(k) || "").trim();
    if (raw === "") continue;
    const num = parseNum(raw);
    if (Number.isNaN(num) || num < 0) {
      return i.reply({ ephemeral: true, content: `Invalid number for ${k}.` });
    }
    if (num > 0) sess.payload[k] = num;
  }
  sendSessions.set(i.user.id, sess);

  // Build progress view with summary and resolved name/link/flag
  const total = sendPageCountAll();

  const btns: ButtonBuilder[] = [];
  for (let p = 0; p < total; p++) {
    btns.push(
      new ButtonBuilder()
        .setCustomId(`send:open:${p}`)
        .setLabel(`Page ${p + 1}/${total}`)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (btns[page]) btns[page].setStyle(ButtonStyle.Primary);

  const rows: any[] = [];
  if (btns.length > 0) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...btns.slice(0, 5)));
  if (btns.length > 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...btns.slice(5, 10)));

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("send:review").setStyle(ButtonStyle.Success).setLabel("Review & Confirm"),
      new ButtonBuilder().setCustomId("send:cancel").setStyle(ButtonStyle.Danger).setLabel("Cancel")
    )
  );

  const summary = Object.entries(sess.payload)
    .filter(([k, v]) => ORDER.includes(k as any) && Number(v) > 0)
    .map(([k, v]) => `${RES_EMOJI[k as any] ?? ""}${k}: ${Number(v).toLocaleString()}`)
    .join("  •  ") || "— none yet —";

  const destStr = sess.destType === "NATION" ? "Nation" : "Alliance";
  const targetUrl = sess.destType === "NATION"
    ? (sess.targetId ? `https://politicsandwar.com/nation/id=${sess.targetId}` : null)
    : (sess.targetId ? `https://politicsandwar.com/alliance/id=${sess.targetId}` : null);

  const lines: string[] = [];
  lines.push(`**Recipient**: ${destStr}${sess.targetId ? ` #${sess.targetId}` : ""}`);
  if (sess.targetName) lines.push(`**Name**: ${sess.targetName}`);
  if (targetUrl) lines.push(`[Open link](${targetUrl})`);
  lines.push(``);
  lines.push(`**Note**: ${sess.note && sess.note.length ? sess.note : "—"}`);
  lines.push(``);
  lines.push(`**Selected so far**:`);
  lines.push(summary);

  const embed = new EmbedBuilder()
    .setTitle("🧾 Send — In Progress")
    .setDescription(lines.join("\n"))
    .setColor(Colors.Gold);

  if (sess.targetFlag) embed.setThumbnail(sess.targetFlag);

  await i.reply({ embeds: [embed], components: rows, ephemeral: true });
}

// =====================
// Review / Confirm
// =====================
async function handleReview(i: ButtonInteraction) {
  const sess = sendSessions.get(i.user.id);
  if (!sess || !sess.destType || !sess.targetId) {
    return i.reply({ ephemeral: true, content: "Please finish the form first (recipient + amounts)." });
  }

  // Validate available balance
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? "" } });
  if (!alliance) return i.reply({ ephemeral: true, content: "No alliance linked here." });

  const member = await prisma.member.findFirst({
    where: { allianceId: alliance.id, discordId: i.user.id },
    include: { balance: true }
  });
  if (!member || !member.balance) {
    return i.reply({ ephemeral: true, content: "No safekeeping found. Run /link_nation first." });
  }

  const over: string[] = [];
  for (const [k, v] of Object.entries(sess.payload)) {
    if (!ORDER.includes(k as any)) continue;
    const have = Number((member.balance as any)[k] || 0);
    if (Number(v) > have) over.push(`${k} (requested ${Number(v).toLocaleString()}, have ${have.toLocaleString()})`);
  }
  if (over.length) {
    return i.reply({ ephemeral: true, content: `Requested more than available:\n• ${over.join("\n• ")}` });
  }

  // Ensure we have a name/flag if possible
  if (!sess.targetName || !sess.targetFlag) {
    try {
      const { name, flag } = await lookupRecipient(sess.destType, sess.targetId, i.guildId);
      if (!sess.targetName && name) sess.targetName = name;
      if (!sess.targetFlag && flag) sess.targetFlag = flag;
      sendSessions.set(i.user.id, sess);
    } catch { /* ignore */ }
  }

  const totalStr = Object.entries(sess.payload)
    .filter(([k, v]) => ORDER.includes(k as any) && Number(v) > 0)
    .map(([k, v]) => fmtLine(k, Number(v)))
    .join(" · ") || "—";

  const destStr = sess.destType === "NATION" ? "Nation" : "Alliance";
  const targetUrl = sess.destType === "NATION"
    ? `https://politicsandwar.com/nation/id=${sess.targetId}`
    : `https://politicsandwar.com/alliance/id=${sess.targetId}`;

  const desc = [
    `You are about to send **from your safekeeping** to **${destStr} #${sess.targetId}**.`,
    sess.targetName ? `**Name**: ${sess.targetName}` : "",
    `${targetUrl ? `[Open target link](${targetUrl})` : ""}`,
    "",
    `**Note**: ${sess.note && sess.note.length ? sess.note : "—"}`,
  ].filter(Boolean).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("✅ Review Send")
    .setDescription(desc)
    .addFields({ name: "Amount", value: totalStr })
    .setColor(Colors.Green);

  if (sess.targetFlag) embed.setThumbnail(sess.targetFlag);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("send:confirm").setStyle(ButtonStyle.Success).setLabel("Confirm — Send for Banker Approval"),
    new ButtonBuilder().setCustomId("send:cancel").setStyle(ButtonStyle.Danger).setLabel("Cancel")
  );

  await i.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleConfirm(i: ButtonInteraction) {
  const sess = sendSessions.get(i.user.id);
  if (!sess || !sess.destType || !sess.targetId) {
    return i.reply({ ephemeral: true, content: "Session not ready. Start again with **/send**." });
  }

  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? "" } });
  if (!alliance) return i.reply({ ephemeral: true, content: "No alliance linked here." });

  const member = await prisma.member.findFirst({
    where: { allianceId: alliance.id, discordId: i.user.id },
    include: { balance: true }
  });
  if (!member || !member.balance) {
    return i.reply({ ephemeral: true, content: "No safekeeping found. Run /link_nation first." });
  }

  const clean = onlyResourceEntries(sess.payload);
  if (!Object.keys(clean).length) {
    return i.reply({ ephemeral: true, content: "Nothing selected to send." });
  }

  // Store destination + note (+ name/flag) inside payload._meta
  const payloadToSave: Record<string, any> = {
    ...clean,
    _meta: {
      destType: sess.destType,
      receiverId: sess.targetId,
      note: sess.note || null,
      name: sess.targetName || null,
      flag: sess.targetFlag || null,
    }
  };

  const req = await prisma.withdrawalRequest.create({
    data: {
      allianceId: alliance.id,
      memberId: member.id,
      createdBy: i.user.id,
      status: "PENDING",
      payload: payloadToSave,
    },
  });

  const reqLine = Object.entries(clean).map(([k, v]) => fmtLine(k, v)).join(" · ");
  const targetUrl = sess.destType === "NATION"
    ? `https://politicsandwar.com/nation/id=${sess.targetId}`
    : `https://politicsandwar.com/alliance/id=${sess.targetId}`;

  const header = sess.destType === "NATION"
    ? `to Nation #${sess.targetId}`
    : `to Alliance #${sess.targetId}`;

  const embed = new EmbedBuilder()
    .setTitle("📤 Send Request (Safekeeping)")
    .setDescription([
      `From <@${i.user.id}> — [${member.nationName}](https://politicsandwar.com/nation/id=${member.nationId})`,
      `**Destination**: ${header}${sess.targetName ? ` (${sess.targetName})` : ""}${targetUrl ? ` — [link](${targetUrl})` : ""}`,
      `**Note**: ${sess.note && sess.note.length ? sess.note : "—"}`,
    ].join("\n"))
    .addFields({ name: "Requested", value: reqLine || "—" })
    .setColor(Colors.Gold);

  if (sess.targetFlag) embed.setThumbnail(sess.targetFlag);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`send:req:approve:${req.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`send:req:deny:${req.id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );

  await i.reply({ ephemeral: true, content: "✅ Request submitted for banker review." });

  const targetChannelId = alliance.reviewChannelId || i.channelId;
  try {
    const ch = await i.client.channels.fetch(targetChannelId);
    if (ch && "send" in ch) await (ch as any).send({ embeds: [embed], components: [row] });
  } catch { /* ignore */ }
}

// =====================
// Banker Approval Buttons
// =====================
export async function handleApprovalButton(i: ButtonInteraction) {
  if (!i.memberPermissions?.has("ManageGuild" as any)) {
    return i.reply({ ephemeral: true, content: "You lack permission to approve/deny." });
  }

  const cid = String(i.customId);
  const id = cid.split(":").pop();
  if (!id) return i.reply({ ephemeral: true, content: "Bad request id." });

  const isApprove = cid.startsWith("send:req:approve:");
  const isDeny = cid.startsWith("send:req:deny:");

  const req = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!req) return i.reply({ ephemeral: true, content: "Request not found." });
  if (req.status !== "PENDING") return i.reply({ ephemeral: true, content: `Already ${req.status}.` });

  if (isDeny) {
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "REJECTED", reviewerId: i.user.id } });

    const rowDisabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
    );
    const emb = new EmbedBuilder().setTitle("❌ Send Rejected").setDescription(`Request **${id}**`).setColor(Colors.Red);
    await i.update({ embeds: [emb], components: [rowDisabled] });

    try {
      const m = await prisma.member.findUnique({ where: { id: req.memberId } });
      if (m) {
        const user = await i.client.users.fetch(m.discordId);
        await user.send({ embeds: [new EmbedBuilder().setTitle("❌ Send Rejected").setDescription(`Request **${id}** — reviewed by <@${i.user.id}>`).setColor(Colors.Red)] });
      }
    } catch { /* ignore */ }
    return;
  }

  if (isApprove) {
    const meta = (req.payload as any)?._meta || {};
    const destType: DestType = meta.destType === "ALLIANCE" ? "ALLIANCE" : "NATION";
    const receiverId: number = Number(meta.receiverId || 0);
    const note: string | null = meta.note || null;
    const nameMeta: string | null = meta.name || null;
    const flagMeta: string | null = httpsOrNull(meta.flag || null);

    const alliance = await prisma.alliance.findUnique({
      where: { id: req.allianceId },
      include: { keys: { orderBy: { id: "desc" }, take: 1 } }
    });
    const member = await prisma.member.findUnique({ where: { id: req.memberId } });

    const apiKeyEnc = alliance?.keys?.[0];
    const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
    const botKey = process.env.PNW_BOT_KEY || "";

    if (!member || !apiKey || !botKey || !receiverId) {
      await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });

      const rowDisabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      const emb = new EmbedBuilder()
        .setTitle("⚠️ Send Approved — Manual Action Needed")
        .setDescription(`Request **${id}**`)
        .setColor(Colors.Yellow);
      if (flagMeta) emb.setThumbnail(flagMeta);
      await i.update({ embeds: [emb], components: [rowDisabled] });
      return i.followUp({ ephemeral: true, content: "Approved but **auto-send skipped** (missing keys/member/receiver). Handle manually." });
    }

    const resPayload = onlyResourceEntries(req.payload as any);
    const apiNote = note && String(note).length ? note : `GemstoneTools send ${id} • reviewer ${i.user.id}`;

    const ok = await pnwSend({
      apiKey, botKey,
      destType,
      receiverId,
      payload: resPayload,
      note: apiNote,
    });

    if (!ok) {
      await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });

      const rowDisabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      const emb = new EmbedBuilder()
        .setTitle("⚠️ Send Approved — Auto-send Failed")
        .setDescription(`Request **${id}**`)
        .setColor(Colors.Yellow);
      if (flagMeta) emb.setThumbnail(flagMeta);
      await i.update({ embeds: [emb], components: [rowDisabled] });
      return i.followUp({ ephemeral: true, content: "Auto-send failed. Left as **APPROVED**." });
    }

    const dec: any = {};
    for (const [k, v] of Object.entries(resPayload)) dec[k] = { decrement: Number(v) || 0 };
    await prisma.safekeeping.update({ where: { memberId: req.memberId }, data: dec });
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "PAID", reviewerId: i.user.id } });

    const rowDisabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
    );
    const emb = new EmbedBuilder()
      .setTitle("💵 Send Completed")
      .setDescription(`Request **${id}**${nameMeta ? ` — ${nameMeta}` : ""}`)
      .setColor(Colors.Blurple);
    if (flagMeta) emb.setThumbnail(flagMeta);
    await i.update({ embeds: [emb], components: [rowDisabled] });

    try {
      const m = await prisma.member.findUnique({ where: { id: req.memberId } });
      if (m) {
        const user = await i.client.users.fetch(m.discordId);
        const paidLine = Object.entries(resPayload).map(([k, v]) => fmtLine(k, Number(v))).join(" · ") || "—";
        const dmEmb = new EmbedBuilder()
          .setTitle("💵 Send Paid")
          .setDescription(`Your send request **${id}** has been sent in-game.${nameMeta ? `\n**Recipient**: ${nameMeta}` : ""}`)
          .addFields({ name: "Amount", value: paidLine })
          .setColor(Colors.Blurple);
        if (flagMeta) dmEmb.setThumbnail(flagMeta);
        await user.send({ embeds: [dmEmb] });
      }
    } catch { /* ignore */ }
    return;
  }

  return i.reply({ ephemeral: true, content: "Unsupported action." });
}

// =====================
// UI helpers
// =====================
async function openModalPage(i: ButtonInteraction, page: number, includeTargetAndNote: boolean) {
  const sess = sendSessions.get(i.user.id);
  if (!sess) {
    return i.reply({ ephemeral: true, content: "Session expired. Start again with **/send**." });
  }
  if (!sess.destType) {
    return i.reply({ ephemeral: true, content: "Select a recipient type first (Send to Nation or Send to Alliance)." });
  }

  // Pull available balance so we can show (avail: X) in field labels
  let avail: Record<string, number> = {};
  try {
    const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? "" } });
    if (alliance) {
      const member = await prisma.member.findFirst({
        where: { allianceId: alliance.id, discordId: i.user.id },
        include: { balance: true }
      });
      const bal: any = member?.balance || {};
      for (const k of ORDER) avail[k] = Number(bal[k] || 0);
    }
  } catch { /* ignore; just omit labels if fail */ }

  const total = sendPageCountAll();
  const keys = sendSliceAll(page, includeTargetAndNote);

  const modal = new ModalBuilder()
    .setCustomId(`send:modal:${page}`)
    .setTitle(`📤 Send (${page + 1}/${total})`);

  if (includeTargetAndNote) {
    const target = new TextInputBuilder()
      .setCustomId("target")
      .setLabel(sess.destType === "NATION" ? "Nation ID or Link" : "Alliance ID or Link")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder(sess.destType === "NATION" ? "e.g. 696150 or https://politicsandwar.com/nation/id=696150" : "e.g. 1234 or https://politicsandwar.com/alliance/id=1234");

    const note = new TextInputBuilder()
      .setCustomId("note")
      .setLabel("Optional Note (shown in-game)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder("e.g. War aid round 2");

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(target),
      new ActionRowBuilder<TextInputBuilder>().addComponents(note)
    );
  }

  for (const k of keys) {
    const labelAvail = typeof avail[k] === "number" ? ` (avail: ${avail[k].toLocaleString()})` : "";
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${RES_EMOJI[k as any] ?? ""} ${k}${labelAvail}`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder("0");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  // Cap check: includeTargetAndNote (2) + 3 fields = 5, other pages = 5
  await i.showModal(modal);
}
