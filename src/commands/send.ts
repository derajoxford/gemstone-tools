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
import { PrismaClient, WithdrawStatus } from "@prisma/client";
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

// ---- Session (per user)
type DestType = "NATION" | "ALLIANCE";
type SendSession = {
  destType: DestType | null;
  targetId: number | null;
  targetLink?: string | null;
  note?: string | null;
  payload: Record<string, number>;
  createdAt: number;
};
const sendSessions = new Map<string, SendSession>();

// ---- Paging
const SEND_PAGE_SIZE = 5;
function sendPageCountAll() { return Math.ceil(ORDER.length / SEND_PAGE_SIZE); }
function sendSliceAll(page: number) { const s = page * SEND_PAGE_SIZE; return ORDER.slice(s, s + SEND_PAGE_SIZE); }

// ---- Extract ID from "id=12345" style links or raw numbers
function extractId(input: string): number | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Try to pick the last long-ish number in the string
  // e.g. https://politicsandwar.com/nation/id=696150 -> 696150
  const matchIdEq = trimmed.match(/(?:^|[^\d])(\d{2,9})(?!\d)/g);
  if (matchIdEq) {
    const last = matchIdEq[matchIdEq.length - 1];
    const digits = last.replace(/\D/g, "");
    const id = Number(digits);
    if (Number.isInteger(id) && id > 0) return id;
  }

  // Or just a plain number
  const num = Number(trimmed);
  if (Number.isInteger(num) && num > 0) return num;

  return null;
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

  // PnW GraphQL:
  // bankWithdraw(receiver:<id>, receiver_type:<1|2>, <res fields>, note:"<str>")
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
    note: null,
    payload: {},
    createdAt: Date.now(),
  });

  const embed = new EmbedBuilder()
    .setTitle("💎 Send from Safekeeping")
    .setDescription("Pick a recipient type to start. You’ll enter the Nation/Alliance **ID or link**, select resources on pages, add a note, then **Review & Confirm** to send for banker approval.")
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
    destType: null, targetId: null, targetLink: null, payload: {}, note: null, createdAt: Date.now()
  };
  sendSessions.set(i.user.id, sess);

  // Pick Nation/Alliance (opens first modal page)
  if (i.customId === "send:pick:nation" || i.customId === "send:pick:alliance") {
    const dest: DestType = i.customId.endsWith("nation") ? "NATION" : "ALLIANCE";
    sess.destType = dest;
    sendSessions.set(i.user.id, sess);
    return openModalPage(i, 0, true); // page 0, include target + note
  }

  // Open resource page N
  if (i.customId.startsWith("send:open:")) {
    const page = Math.max(0, parseInt(i.customId.split(":")[2] || "0", 10));
    return openModalPage(i, page, false); // pages >0, no target field, no note
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

  // Fallback
  return i.reply({ ephemeral: true, content: "Something went wrong. Try again." });
}

// =====================
// Modal router
// =====================
export async function handleModal(i: any) {
  // customId formats:
  //  - "send:modal:0" (first page with target + note + first resources)
  //  - "send:modal:1", "send:modal:2", ... (resource-only pages)
  if (!String(i.customId).startsWith("send:modal:")) return;

  const sess = sendSessions.get(i.user.id);
  if (!sess) return i.reply({ ephemeral: true, content: "Session expired. Start again with **/send**." });

  const page = Math.max(0, parseInt(String(i.customId).split(":")[2] || "0", 10));
  const keys = sendSliceAll(page);

  // First page: target + note
  if (page === 0) {
    const targetRaw = (i.fields.getTextInputValue("target") || "").trim();
    const noteRaw = (i.fields.getTextInputValue("note") || "").trim();
    const id = extractId(targetRaw);

    if (!sess.destType) {
      return i.reply({
        ephemeral: true,
        content: "Select a recipient type first (Send to Nation or Send to Alliance)."
      });
    }
    if (!id) {
      return i.reply({
        ephemeral: true,
        content: "Please enter a valid **ID** or a proper **link** that contains an ID."
      });
    }
    sess.targetId = id;
    sess.targetLink = targetRaw || null;
    sess.note = noteRaw || null;
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

  // After submit, show paging controls + Review/Cancel
  const total = sendPageCountAll();
  const btns: ButtonBuilder[] = [];

  for (let p = 0; p < total; p++) {
    btns.push(
      new ButtonBuilder()
        .setCustomId(`send:open:${p}`)
        .setLabel(`Page ${p + 1}/${total}`)
        .setStyle(p === page ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );
  }

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns.slice(0, Math.min(5, btns.length)));
  const row2 = btns.length > 5 ? new ActionRowBuilder<ButtonBuilder>().addComponents(...btns.slice(5)) : null;

  const reviewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("send:review").setStyle(ButtonStyle.Success).setLabel("Review & Confirm"),
    new ButtonBuilder().setCustomId("send:cancel").setStyle(ButtonStyle.Danger).setLabel("Cancel")
  );

  const summary = Object.entries(sess.payload)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${RES_EMOJI[k as any] ?? ""}${k}: ${Number(v).toLocaleString()}`)
    .join("  •  ") || "— none yet —";

  const destStr = sess.destType === "NATION" ? "Nation" : "Alliance";
  const targetUrl = sess.destType === "NATION"
    ? (sess.targetId ? `https://politicsandwar.com/nation/id=${sess.targetId}` : null)
    : (sess.targetId ? `https://politicsandwar.com/alliance/id=${sess.targetId}` : null);

  const embed = new EmbedBuilder()
    .setTitle("🧾 Send — In Progress")
    .setDescription([
      `**Recipient**: ${destStr}${sess.targetId ? ` #${sess.targetId}` : ""}${targetUrl ? ` — [link](${targetUrl})` : ""}`,
      `**Note**: ${sess.note && sess.note.length ? sess.note : "—"}`,
      "",
      `**Selected so far**:`,
      summary
    ].join("\n"))
    .setColor(Colors.Gold);

  const rows: any[] = [row1];
  if (row2) rows.push(row2);
  rows.push(reviewRow);

  await i.reply({ embeds: [embed], components: rows, ephemeral: true });
}

// =====================
// Review / Confirm
// =====================
async function handleReview(i: ButtonInteraction) {
  const sess = sendSessions.get(i.user.id);
  if (!sess || !sess.destType || !sess.targetId) {
    return i.reply({
      ephemeral: true,
      content: "Please finish the form first (recipient + amounts)."
    });
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

  const totalStr = Object.entries(sess.payload)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => fmtLine(k, Number(v)))
    .join(" · ") || "—";

  const destStr = sess.destType === "NATION" ? "Nation" : "Alliance";
  const targetUrl = sess.destType === "NATION"
    ? `https://politicsandwar.com/nation/id=${sess.targetId}`
    : `https://politicsandwar.com/alliance/id=${sess.targetId}`;

  const embed = new EmbedBuilder()
    .setTitle("✅ Review Send")
    .setDescription([
      `You are about to send **from your safekeeping** to **${destStr} #${sess.targetId}**.`,
      `${targetUrl ? `[Open target link](${targetUrl})` : ""}`,
      "",
      `**Note**: ${sess.note && sess.note.length ? sess.note : "—"}`,
    ].join("\n"))
    .addFields({ name: "Amount", value: totalStr })
    .setColor(Colors.Green);

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

  // Validate has alliance + member + balance again
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? "" } });
  if (!alliance) return i.reply({ ephemeral: true, content: "No alliance linked here." });

  const member = await prisma.member.findFirst({
    where: { allianceId: alliance.id, discordId: i.user.id },
    include: { balance: true }
  });
  if (!member || !member.balance) {
    return i.reply({ ephemeral: true, content: "No safekeeping found. Run /link_nation first." });
  }

  // Final payload cleanup: keep only > 0
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(sess.payload)) {
    if (!ORDER.includes(k as any)) continue;
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) clean[k] = num;
  }
  if (!Object.keys(clean).length) {
    return i.reply({ ephemeral: true, content: "Nothing selected to send." });
  }

  // Create request in DB (re-using WithdrawalRequest table)
  // IMPORTANT: do NOT include `note` in prisma call (column doesn't exist)
  const req = await prisma.withdrawalRequest.create({
    data: {
      allianceId: alliance.id,
      memberId: member.id,
      createdBy: i.user.id,
      status: "PENDING",
      payload: clean,
      kind: sess.destType, // Prisma has this column in your schema based on earlier logs
      recipientNationId: sess.destType === "NATION" ? sess.targetId : null,
      recipientAllianceId: sess.destType === "ALLIANCE" ? sess.targetId : null,
    },
  });

  // Build banker review card
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
      `**Destination**: ${header}${targetUrl ? ` — [link](${targetUrl})` : ""}`,
      `**Note**: ${sess.note && sess.note.length ? sess.note : "—"}`,
    ].join("\n"))
    .addFields({ name: "Requested", value: reqLine || "—" })
    .setColor(Colors.Gold);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`send:req:approve:${req.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`send:req:deny:${req.id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );

  // Ack to requester
  await i.reply({ ephemeral: true, content: "✅ Request submitted for banker review." });

  // Post to review channel (or here as fallback)
  const targetChannelId = alliance.reviewChannelId || i.channelId;
  try {
    const ch = await i.client.channels.fetch(targetChannelId);
    if (ch && "send" in ch) await (ch as any).send({ embeds: [embed], components: [row] });
  } catch { /* ignore */ }

  // Keep session (note lives only in session; DB has no note field)
}

// =====================
// Banker Approval Buttons
// =====================
export async function handleApprovalButton(i: ButtonInteraction) {
  // Permissions
  if (!i.memberPermissions?.has("ManageGuild" as any)) {
    return i.reply({ ephemeral: true, content: "You lack permission to approve/deny." });
  }

  const [prefix, action, id] = String(i.customId).split(":"); // send:req:<action>:<id> -> we used send:req:approve:<id>
  if (prefix !== "send" || !id) return;

  const req = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!req) return i.reply({ ephemeral: true, content: "Request not found." });
  if (req.status !== "PENDING") return i.reply({ ephemeral: true, content: `Already ${req.status}.` });

  // Deny path
  if (action === "req" || action === "deny") {
    // Some older buttons might be "send:req:deny:<id>"
    if (String(i.customId).includes(":deny:")) {
      await prisma.withdrawalRequest.update({ where: { id }, data: { status: "REJECTED", reviewerId: i.user.id } });

      // Disable buttons
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      const emb = new EmbedBuilder().setTitle("❌ Send Rejected").setDescription(`Request **${id}**`).setColor(Colors.Red);
      await i.update({ embeds: [emb], components: [row] });

      // DM requester
      try {
        const m = await prisma.member.findUnique({ where: { id: req.memberId } });
        if (m) {
          const user = await i.client.users.fetch(m.discordId);
          await user.send({ embeds: [new EmbedBuilder().setTitle("❌ Send Rejected").setDescription(`Request **${id}** — reviewed by <@${i.user.id}>`).setColor(Colors.Red)] });
        }
      } catch { /* ignore */ }
      return;
    }
  }

  // Approve path: perform in-game transfer
  // Fetch alliance & member for keys and for decrement
  const alliance = await prisma.alliance.findUnique({
    where: { id: req.allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } }
  });
  const member = await prisma.member.findUnique({ where: { id: req.memberId } });

  const apiKeyEnc = alliance?.keys?.[0];
  const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
  const botKey = process.env.PNW_BOT_KEY || "";

  if (!member || !apiKey || !botKey) {
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });
    return i.reply({ ephemeral: true, content: "⚠️ Approved but **auto-send skipped** (missing API key / bot key / member). Handle manually." });
  }

  // We did not store 'note' in DB, so embed won't have it here.
  // Use a deterministic note for the in-game record:
  const note = `GemstoneTools send ${id} • reviewer ${i.user.id}`;

  const destType = (req as any).kind as DestType;
  const receiverId = destType === "NATION" ? (req as any).recipientNationId : (req as any).recipientAllianceId;
  const ok = await pnwSend({
    apiKey, botKey,
    destType,
    receiverId: Number(receiverId),
    payload: req.payload as Record<string, number>,
    note,
  });

  if (!ok) {
    // Mark as approved but not paid; banker can retry manually
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
    );
    const emb = new EmbedBuilder().setTitle("⚠️ Send Approved — Auto-send Failed").setDescription(`Request **${id}**`).setColor(Colors.Yellow);
    await i.update({ embeds: [emb], components: [row] });
    return i.followUp({ ephemeral: true, content: "Auto-send failed. Left as **APPROVED**." });
  }

  // Decrement the requester's safekeeping and mark PAID
  const dec: any = {};
  for (const [k, v] of Object.entries(req.payload as any)) dec[k] = { decrement: Number(v) || 0 };
  await prisma.safekeeping.update({ where: { memberId: req.memberId }, data: dec });
  await prisma.withdrawalRequest.update({ where: { id }, data: { status: "PAID", reviewerId: i.user.id } });

  // Disable buttons + success msg
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
  );
  const emb = new EmbedBuilder().setTitle("💵 Send Completed").setDescription(`Request **${id}**`).setColor(Colors.Blurple);
  await i.update({ embeds: [emb], components: [row] });

  // DM requester
  try {
    const m = await prisma.member.findUnique({ where: { id: req.memberId } });
    if (m) {
      const user = await i.client.users.fetch(m.discordId);
      const paidLine = Object.entries(req.payload as any).map(([k, v]) => fmtLine(k, Number(v))).join(" · ") || "—";
      const dmEmb = new EmbedBuilder()
        .setTitle("💵 Send Paid")
        .setDescription(`Your send request **${id}** has been sent in-game.`)
        .addFields({ name: "Amount", value: paidLine })
        .setColor(Colors.Blurple);
      await user.send({ embeds: [dmEmb] });
    }
  } catch { /* ignore */ }
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
    return i.reply({
      ephemeral: true,
      content: "Select a recipient type first (Send to Nation or Send to Alliance)."
    });
  }

  const total = sendPageCountAll();
  const keys = sendSliceAll(page);

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
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${RES_EMOJI[k as any] ?? ""} ${k} (amount)`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder("0");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  await i.showModal(modal);
}
