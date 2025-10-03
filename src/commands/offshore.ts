// src/commands/offshore.ts
import {
  SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits,
  EmbedBuilder, Colors, ButtonBuilder, ActionRowBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, ButtonInteraction, Interaction
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecs, RESOURCE_KEYS } from "../lib/pnw";
import { getDefaultOffshore, setDefaultOffshore } from "../lib/offshore";
import { open } from "../lib/crypto";

const prisma = new PrismaClient();

// ---------- utils ----------
function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[, _]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
function asNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}
function resLines(obj: Record<string, number>) {
  return RESOURCE_KEYS
    .map(k => {
      const v = Number(obj[k] || 0);
      return v ? `• **${k}**: ${fmt(v)}` : null;
    })
    .filter(Boolean)
    .join("\n") || "— none —";
}
function admins(): Set<string> {
  const raw = (process.env.BOT_ADMIN_DISCORD_ID || "").trim();
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

// ---------- effective offshore ----------
async function resolveOffshoreAid(allianceId: number): Promise<{effective: number|null, override: number|null, global: number|null}> {
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  const global = await getDefaultOffshore();
  const override = a?.offshoreOverrideAllianceId ?? null;
  return { effective: override ?? global ?? null, override, global };
}

// ---------- modal session (paged inputs, 5 per page) ----------
const SEND_PAGE_SIZE = 5;
function sendPageCount() { return Math.ceil(RESOURCE_KEYS.length / SEND_PAGE_SIZE); }
function sendSlice(page: number) {
  const s = page * SEND_PAGE_SIZE;
  return RESOURCE_KEYS.slice(s, s + SEND_PAGE_SIZE);
}
const sendSessions: Map<string, { data: Record<string, number>, createdAt: number }> = new Map();

// ---------- slash definition ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore settings and tools")
  .addSubcommand(sc => sc
    .setName("show")
    .setDescription("Show which offshore is in effect for this alliance"))
  .addSubcommand(sc => sc
    .setName("set_default")
    .setDescription("BOT ADMIN: set the global default offshore alliance id")
    .addIntegerOption(o => o.setName("aid").setDescription("Alliance ID").setRequired(true)))
  .addSubcommand(sc => sc
    .setName("set_override")
    .setDescription("Set or clear this alliance’s offshore override")
    .addIntegerOption(o => o.setName("aid").setDescription("Alliance ID (omit or 0 to clear)").setRequired(false)))
  .addSubcommand(sc => sc
    .setName("holdings")
    .setDescription("Show your alliance’s net holdings in your offshore (recent window, deduped)"))
  .addSubcommand(sc => sc
    .setName("send")
    .setDescription("Send from your alliance bank to the configured offshore (guided form, no JSON)"))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

// ---------- main dispatcher ----------
export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand(true);

  // set_default — strict admin gate (supports CSV in env)
  if (sub === "set_default") {
    const allowed = admins();
    if (!allowed.size) {
      return i.reply({ content: "⚠️ BOT_ADMIN_DISCORD_ID is not set. Ask the host to configure it.", ephemeral: true });
    }
    if (!allowed.has(i.user.id)) {
      return i.reply({ content: "Only the bot admin can set the global default offshore.", ephemeral: true });
    }
    const aid = i.options.getInteger("aid", true);
    await setDefaultOffshore(aid, i.user.id);
    return i.reply({ content: `✅ Global default offshore set → **${aid}**.`, ephemeral: true });
  }

  // resolve alliance from guild
  const ag = await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId! } });
  const alliance = ag
    ? await prisma.alliance.findUnique({ where: { id: ag.allianceId } })
    : await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? "" } });

  if (!alliance) {
    return i.reply({ content: "This server is not linked to an alliance. Use /guild_link_alliance or /setup_alliance.", ephemeral: true });
  }

  if (sub === "show") {
    const { effective, override, global } = await resolveOffshoreAid(alliance.id);

    const embed = new EmbedBuilder()
      .setTitle("🏦 Offshore Configuration")
      .setColor(effective ? Colors.Blurple : Colors.Orange)
      .addFields(
        { name: "Alliance", value: `${alliance.name || "Unnamed"} (**${alliance.id}**)`, inline: true },
        { name: "Override (this alliance)", value: override ? `**${override}**` : "_none_", inline: true },
        { name: "Global default", value: global ? `**${global}**` : "_none_", inline: true },
        { name: "Effective offshore", value: effective ? `**${effective}**` : "—", inline: false },
      )
      .setFooter({ text: "Overrides take precedence over the global default." });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("📤").setLabel("Send to Offshore"),
      new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setEmoji("📊").setLabel("Show Holdings")
    );

    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  if (sub === "set_override") {
    const aid = i.options.getInteger("aid", false) ?? 0;
    await prisma.alliance.update({
      where: { id: alliance.id },
      data: { offshoreOverrideAllianceId: aid || null },
    });
    return i.reply({ content: aid ? `✅ Offshore override set → **${aid}**` : "✅ Offshore override cleared.", ephemeral: true });
  }

  if (sub === "holdings") {
    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
    }
    await i.deferReply({ ephemeral: true });

    // safety: clamp window + timeout
    const take = 300; // last N bankrecs on offshore
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const rows = await fetchBankrecs(offshoreAid, { limit: take });
      const net: Record<string, number> = {};
      for (const k of RESOURCE_KEYS) net[k] = 0;

      const A = String(alliance.id), O = String(offshoreAid);
      const seen = new Set<string>();

      for (const r of rows) {
        const id = String(r.id);
        if (seen.has(id)) continue;
        seen.add(id);

        const fromAtoO = r.sender_type === 2 && String(r.sender_id) === A && r.receiver_type === 2 && String(r.receiver_id) === O;
        const fromOtoA = r.sender_type === 2 && String(r.sender_id) === O && r.receiver_type === 2 && String(r.receiver_id) === A;
        if (!fromAtoO && !fromOtoA) continue;

        const sign = fromAtoO ? +1 : -1;
        for (const k of RESOURCE_KEYS) {
          net[k] = (net[k] || 0) + sign * asNum((r as any)[k]);
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("📊 Offshore Holdings (derived)")
        .setDescription(`**${alliance.name || alliance.id}** ↔ **${offshoreAid}**\nWindow: last ${take} bankrecs on offshore`)
        .addFields({ name: "Net amounts", value: resLines(net) })
        .setColor(Colors.Blurple);

      await i.editReply({ embeds: [embed] });
    } catch (e) {
      await i.editReply({ content: "Timed out while fetching holdings. Try again in a moment.", embeds: [] });
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (sub === "send") {
    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
    }

    // start a session + show "Start" button (paged modal flow)
    sendSessions.set(i.user.id, { data: {}, createdAt: Date.now() });

    const embed = new EmbedBuilder()
      .setTitle("📤 Send to Offshore")
      .setDescription(`Destination offshore: **${offshoreAid}**\nUse **Start** to enter amounts (paged form).`)
      .setColor(Colors.Gold);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("✨").setLabel("Start"),
      new ButtonBuilder().setCustomId("offsh:done").setStyle(ButtonStyle.Success).setEmoji("✅").setLabel("Done")
    );

    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  return i.reply({ content: "Unknown subcommand.", ephemeral: true });
}

// ---------- Button & Modal handlers (wired by index.ts generic router) ----------
export async function handleButton(i: Interaction) {
  if (!i.isButton()) return;

  // show -> quick actions
  if (i.customId === "offsh:check") {
    // mirror holdings subcommand
    const fake = { ...i, options: { getSubcommand: () => "holdings" } } as any;
    return execute(fake);
  }

  if (i.customId.startsWith("offsh:open:")) {
    const page = Math.max(0, parseInt(i.customId.split(":")[2] || "0", 10));
    return offshOpenModalPaged(i as ButtonInteraction, page);
  }

  if (i.customId === "offsh:done") {
    return offshDone(i as ButtonInteraction);
  }
}

export async function handleModal(i: Interaction) {
  if (!i.isModalSubmit()) return;
  if (!i.customId.startsWith("offsh:modal:")) return;

  const m = i.customId.match(/^offsh:modal:(\d+)$/);
  if (!m) return;
  const page = Number(m[1]);

  const sess = sendSessions.get(i.user.id) || { data: {}, createdAt: Date.now() };
  const keys = sendSlice(page);

  for (const k of keys) {
    const raw = i.fields.getTextInputValue(k) || "";
    const num = parseNum(raw);
    if (raw !== "" && (Number.isNaN(num) || num < 0)) {
      return i.reply({ content: `Invalid number for **${k}**.`, ephemeral: true });
    }
    if (num > 0) sess.data[k] = num; else delete sess.data[k];
  }
  sendSessions.set(i.user.id, sess);

  const total = sendPageCount();
  const btns: ButtonBuilder[] = [];
  if (page > 0) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel("◀ Prev"));
  if (page < total - 1) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page + 1}`).setStyle(ButtonStyle.Primary).setLabel(`Next (${page + 2}/${total}) ▶`));
  btns.push(new ButtonBuilder().setCustomId("offsh:done").setStyle(ButtonStyle.Success).setLabel("Done ✅"));

  const summary = Object.entries(sess.data)
    .map(([k, v]) => `**${k}**: ${fmt(Number(v))}`)
    .join(" · ") || "— none yet —";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
  await i.reply({ content: `Saved so far: ${summary}`, components: [row], ephemeral: true });
}

async function offshOpenModalPaged(i: ButtonInteraction, page: number) {
  const total = sendPageCount();
  const keys = sendSlice(page);

  const modal = new ModalBuilder().setCustomId(`offsh:modal:${page}`).setTitle(`📤 Offshore Send (${page + 1}/${total})`);

  for (const k of keys) {
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${k} (enter 0 or leave blank to skip)`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder("0");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  await i.showModal(modal);
}

async function offshDone(i: ButtonInteraction) {
  const sess = sendSessions.get(i.user.id);
  if (!sess || !Object.keys(sess.data).length) {
    return i.reply({ content: "Nothing to send — all zero. Open **Start** and enter amounts.", ephemeral: true });
  }

  // resolve alliance & offshore
  const ag = await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId! } });
  const alliance = ag
    ? await prisma.alliance.findUnique({ where: { id: ag.allianceId } })
    : await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? "" } });

  if (!alliance) return i.reply({ content: "This server is not linked to an alliance.", ephemeral: true });

  const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
  if (!offshoreAid) {
    return i.reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
  }

  // Try auto-send via GraphQL if keys exist; otherwise show manual instruction
  const tryAuto = process.env.AUTOOFFSHORE_ENABLED === "1";
  if (tryAuto) {
    const krec = await prisma.allianceKey.findFirst({ where: { allianceId: alliance.id }, orderBy: { id: "desc" } });
    const apiKey = krec ? open(krec.encryptedApiKey as any, krec.nonceApi as any)
      : (process.env[`PNW_API_KEY_${alliance.id}`] || process.env.PNW_API_KEY || "");
    const botKey = process.env.PNW_BOT_KEY || "";

    if (apiKey && botKey) {
      const fields: string[] = Object.entries(sess.data).map(([k, v]) => `${k}:${Number(v)}`);
      const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${i.user.id}`;
      fields.push(`note:${JSON.stringify(note)}`);

      const q = `mutation{
        bankWithdraw(receiver:${offshoreAid}, receiver_type:2, ${fields.join(",")}) { id }
      }`;

      const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey, "X-Bot-Key": botKey },
        body: JSON.stringify({ query: q })
      }).catch(() => null);

      const ok = !!res && res.ok;
      const json = ok ? await res!.json().catch(() => ({} as any)) : null;
      const success = ok && (json as any)?.data?.bankWithdraw;

      if (success) {
        sendSessions.delete(i.user.id);
        return i.reply({
          content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nVerify with **/offshore holdings** shortly.`,
          ephemeral: true
        });
      }
    }
  }

  // manual fallback
  const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${i.user.id}`;
  const list = Object.entries(sess.data)
    .map(([k, v]) => `• ${k}: ${fmt(Number(v))}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("📤 Manual offshore transfer")
    .setDescription(`Use your **Alliance → Alliance** banker UI to send to **Alliance ${offshoreAid}**.\nPaste the note below.`)
    .addFields(
      { name: "Send these amounts", value: list || "— none —" },
      { name: "Note", value: "```" + note + "```" }
    )
    .setColor(Colors.Gold);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setLabel("Re-check holdings")
  );

  sendSessions.delete(i.user.id);
  await i.reply({ embeds: [embed], components: [row], ephemeral: true });
}
