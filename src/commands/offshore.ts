cd ~/gemstone-tools

# Safety backup
cp src/commands/offshore.ts src/commands/offshore.ts.bak.$(date +%s)

# Write the corrected file (NO leading comment line!)
cat > src/commands/offshore.ts <<'TS'
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  EmbedBuilder,
  Colors,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { open as cryptoOpen } from "../lib/crypto.js";
import { RES_EMOJI, ORDER } from "../lib/emojis.js";
import { catchUpLedgerForPair } from "../lib/offshore_ledger.js";

const prisma = new PrismaClient();

const OFFSH_NOTE_TAG = "Gemstone Offsh";
const RES_PER_MODAL_PAGE = 4;
const emoji = (k: string) => (RES_EMOJI as any)[k] ?? "";
const label = (k: string) => k.slice(0, 1).toUpperCase() + k.slice(1);
const round0 = (n: number) => Number(n || 0);

// ---------- Alliance helpers ----------
async function findAllianceForGuild(guildId?: string) {
  if (!guildId) return null;
  const map = await prisma.allianceGuild.findUnique({ where: { guildId } });
  if (map) {
    const a = await prisma.alliance.findUnique({ where: { id: map.allianceId } });
    if (a) return a;
  }
  return prisma.alliance.findFirst({ where: { guildId } });
}

async function resolveOffshoreAidForAlliance(allianceId: number): Promise<number | null> {
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  if (!a) return null;
  if ((a as any).offshoreOverrideAllianceId) return (a as any).offshoreOverrideAllianceId;

  const s = await prisma.setting.findUnique({ where: { key: "default_offshore_aid" } });
  try {
    const aid = (s?.value as any)?.aid;
    return Number.isFinite(aid) ? Number(aid) : null;
  } catch { return null; }
}

async function getAllianceApiBotKeys(allianceId: number) {
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });

  let apiKey = "";
  const latest = a?.keys?.[0];
  if (latest) {
    try { apiKey = cryptoOpen(latest.encryptedApiKey as any, latest.nonceApi as any); } catch {}
  }
  if (!apiKey) apiKey = process.env.PNW_DEFAULT_API_KEY || "";
  const botKey = process.env.PNW_BOT_KEY || "";
  return { apiKey, botKey };
}

// ---------- PnW send ----------
async function bankWithdrawAlliance(opts: {
  apiKey: string; botKey: string; receiverAllianceId: number; note?: string;
  payload: Record<string, number>;
}): Promise<{ ok: boolean; error?: string }> {
  const fields: string[] = [];
  for (const [k, v] of Object.entries(opts.payload)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) fields.push(`${k}:${n}`);
  }
  if (!fields.length) return { ok: false, error: "Nothing to send (all zero)." };
  if (opts.note) fields.push(`note:${JSON.stringify(opts.note)}`);

  const query = `mutation{
    bankWithdraw(receiver:${opts.receiverAllianceId}, receiver_type:2, ${fields.join(",")}) { id }
  }`;

  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(opts.apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": opts.apiKey, "X-Bot-Key": opts.botKey },
    body: JSON.stringify({ query }),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  if (json?.errors?.length) {
    const msg = json.errors.map((e: any) => e?.message).join("; ");
    return { ok: false, error: msg || "GraphQL error" };
  }
  const id = json?.data?.bankWithdraw?.id;
  return id ? { ok: true } : { ok: false, error: "No ID returned" };
}

// ---------- Slash command ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore tools")
  .addSubcommand(s => s.setName("show").setDescription("Show offshore holdings (running balance, bot-tagged only)"));

export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();
  if (sub === "show") return showHoldings(i);
}

// ---------- Classic holdings card ----------
async function showHoldings(i: ChatInputCommandInteraction) {
  const alliance = await findAllianceForGuild(i.guildId ?? undefined);
  if (!alliance) return i.reply({ content: "Run /setup_alliance first.", ephemeral: true });

  const offshoreAid = await resolveOffshoreAidForAlliance(alliance.id);
  if (!offshoreAid) return i.reply({ content: "No offshore alliance configured.", ephemeral: true });

  try { await catchUpLedgerForPair(prisma, alliance.id, offshoreAid); } catch {}

  const ledger = await prisma.offshoreLedger.findUnique({
    where: { allianceId_offshoreId: { allianceId: alliance.id, offshoreId: offshoreAid } },
  });

  const embed = new EmbedBuilder()
    .setTitle(`📊 Offshore Holdings — ${alliance.id}`)
    .setDescription(`**${alliance.id}** held in offshore **${offshoreAid}**\n_Running balance (bot-tagged only)_`)
    .setColor(Colors.Blurple)
    .setTimestamp(ledger?.updatedAt ?? new Date());

  const blocks: string[] = [];
  if (ledger) {
    const money = round0((ledger as any).money);
    if (money > 0) blocks.push(`${emoji("money")} **Money**\n$${money.toLocaleString()}`);
    for (const k of ORDER) {
      if (k === "money") continue;
      const v = round0((ledger as any)[k]);
      if (v > 0) blocks.push(`${emoji(k)} **${label(k)}**\n${v.toLocaleString()}`);
    }
  }
  embed.addFields({ name: "Balances", value: blocks.length ? blocks.join("\n\n") : "— none —" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("offsh:refresh").setStyle(ButtonStyle.Secondary).setLabel("Refresh Now"),
    new ButtonBuilder().setCustomId("offsh:send:open:0").setStyle(ButtonStyle.Primary).setLabel("Send to Offshore")
  );

  await i.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ---------- Send flow (submit any time) ----------
type SendSess = { allianceId: number; offshoreAid: number; page: number; note?: string; amounts: Record<string, number>; createdAt: number; };
const sendSessions = new Map<string, SendSess>();
const totalPages = () => Math.ceil(ORDER.length / RES_PER_MODAL_PAGE);
const pageKeys = (p: number) => ORDER.slice(p * RES_PER_MODAL_PAGE, p * RES_PER_MODAL_PAGE + RES_PER_MODAL_PAGE);

function previewEmbed(sess: SendSess) {
  const lines = Object.entries(sess.amounts).filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${emoji(k)} **${label(k)}**: ${Number(v).toLocaleString()}`);
  return new EmbedBuilder()
    .setTitle("Send to Offshore — Preview")
    .setDescription(lines.length ? lines.join(" · ") : "— none —")
    .setFooter({ text: `Alliance ${sess.allianceId} → Offshore ${sess.offshoreAid}` })
    .setColor(Colors.Blurple);
}

async function openSendModal(i: ButtonInteraction, page: number) {
  const sess = sendSessions.get(i.user.id);
  if (!sess) return i.reply({ content: "Session expired. Press **Send to Offshore** again.", ephemeral: true });
  sess.page = page; sendSessions.set(i.user.id, sess);

  const modal = new ModalBuilder().setCustomId(`offsh:send:modal:${page}`).setTitle(`Send to Offshore (${page + 1}/${totalPages()})`);
  for (const k of pageKeys(page)) {
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(`res:${k}`)
        .setLabel(`${emoji(k)} ${label(k)} (leave blank for 0)`)
        .setStyle(TextInputStyle.Short).setRequired(false)
        .setPlaceholder(String(sess.amounts[k] ?? 0))
    ));
  }
  if (page === 0) {
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("meta:note").setLabel("Note (optional)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(sess.note ?? "")
    ));
  }
  await i.showModal(modal);
}

async function submitSend(i: ButtonInteraction | ModalSubmitInteraction, sess: SendSess) {
  const payload: Record<string, number> = {};
  for (const [k, v] of Object.entries(sess.amounts)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) payload[k] = n;
  }
  if (!Object.keys(payload).length) {
    const msg = { content: "Nothing to send — all zero.", ephemeral: true };
    // @ts-ignore
    return (i.reply ?? i.followUp).call(i, msg);
  }

  const { apiKey, botKey } = await getAllianceApiBotKeys(sess.allianceId);
  if (!apiKey) return i.reply({ content: "No alliance API key set. Run **/setup_alliance**.", ephemeral: true });
  if (!botKey) return i.reply({ content: "Missing PNW_BOT_KEY in environment.", ephemeral: true });

  const note = `${OFFSH_NOTE_TAG}${sess.note ? " • " + sess.note : ""}`;
  const res = await bankWithdrawAlliance({ apiKey, botKey, receiverAllianceId: sess.offshoreAid, note, payload });

  if (!res.ok) {
    const msg = /api key/i.test(res.error || "") ? "Alliance API key looks invalid. Re-run **/setup_alliance**." : (res.error || "Unknown error.");
    return i.reply({ content: `❌ Send failed: ${msg}`, ephemeral: true });
  }

  try { await catchUpLedgerForPair(prisma, sess.allianceId, sess.offshoreAid); } catch {}
  sendSessions.delete((i as any).user?.id ?? "");
  const ok = new EmbedBuilder()
    .setTitle("✅ Sent to Offshore")
    .setDescription(Object.entries(payload).map(([k, v]) => `${emoji(k)} **${label(k)}**: ${v.toLocaleString()}`).join(" · "))
    .setColor(Colors.Green);
  // @ts-ignore
  return (i.update ?? i.reply).call(i, { embeds: [ok], components: [], ephemeral: "update" in i ? undefined : true });
}

// ---------- Routers ----------
export async function handleButton(i: ButtonInteraction) {
  if (!i.customId.startsWith("offsh:")) return;

  if (i.customId === "offsh:refresh") {
    return showHoldings(i as any as ChatInputCommandInteraction);
  }

  if (i.customId.startsWith("offsh:send:open:")) {
    const alliance = await findAllianceForGuild(i.guildId ?? undefined);
    if (!alliance) return i.reply({ content: "Run /setup_alliance first.", ephemeral: true });
    const offshoreAid = await resolveOffshoreAidForAlliance(alliance.id);
    if (!offshoreAid) return i.reply({ content: "No offshore alliance configured.", ephemeral: true });

    sendSessions.set(i.user.id, { allianceId: alliance.id, offshoreAid, page: 0, amounts: {}, createdAt: Date.now() });
    return openSendModal(i, 0);
  }

  if (i.customId === "offsh:send:cancel") {
    sendSessions.delete(i.user.id);
    return i.update({ content: "Canceled.", embeds: [], components: [] }).catch(() => {});
  }

  if (i.customId === "offsh:send:submit") {
    const sess = sendSessions.get(i.user.id);
    if (!sess) return i.reply({ content: "Session expired. Press **Send to Offshore** again.", ephemeral: true });
    return submitSend(i, sess);
  }

  const m = i.customId.match(/^offsh:send:page:(\d+)$/);
  if (m) return openSendModal(i, Math.max(0, parseInt(m[1]!, 10)));
}

export async function handleModal(i: ModalSubmitInteraction) {
  if (!i.customId.startsWith("offsh:send:modal:")) return;
  const sess = sendSessions.get(i.user.id);
  if (!sess) return i.reply({ content: "Session expired. Press **Send to Offshore** again.", ephemeral: true });

  const page = parseInt(i.customId.split(":").pop()!, 10);
  for (const k of pageKeys(page)) {
    const raw = (i.fields.getTextInputValue(`res:${k}`) || "").trim();
    if (!raw) { delete sess.amounts[k]; continue; }
    const n = Number(raw.replace(/[, _]/g, ""));
    if (!Number.isFinite(n) || n < 0) return i.reply({ content: `Invalid number for ${label(k)}.`, ephemeral: true });
    if (n === 0) delete sess.amounts[k]; else sess.amounts[k] = n;
  }
  if (page === 0) {
    const noteRaw = (i.fields.getTextInputValue("meta:note") || "").trim();
    sess.note = noteRaw || undefined;
  }
  sendSessions.set(i.user.id, sess);

  const total = totalPages();
  const btns: ButtonBuilder[] = [];
  if (page > 0) btns.push(new ButtonBuilder().setCustomId(`offsh:send:page:${page - 1}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary));
  if (page < total - 1) btns.push(new ButtonBuilder().setCustomId(`offsh:send:page:${page + 1}`).setLabel(`Next ▶ (${page + 2}/${total})`).setStyle(ButtonStyle.Secondary));
  btns.push(new ButtonBuilder().setCustomId("offsh:send:submit").setLabel("Submit Now").setStyle(ButtonStyle.Success));
  btns.push(new ButtonBuilder().setCustomId("offsh:send:cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
  await i.reply({ embeds: [previewEmbed(sess)], components: [row], ephemeral: true });
}
TS

# Make sure there are NO occurrences of the old handlers
grep -nE 'offsh:send:(review|confirm)' src/commands/offshore.ts || echo "👍 No legacy buttons present"
