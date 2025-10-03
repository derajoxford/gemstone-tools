// src/commands/offshore.ts

import {
  SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits,
  EmbedBuilder, Colors, ButtonBuilder, ActionRowBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, ButtonInteraction, Interaction
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecs, RESOURCE_KEYS } from "../lib/pnw.js";
import { getDefaultOffshore, setDefaultOffshore } from "../lib/offshore.js";
import { open } from "../lib/crypto.js";

const prisma = new PrismaClient();

/**
 * We keep a lightweight in-memory cache of the last computed “windowed holdings”
 * so the Send modal can display (est.) availability without hitting the API again.
 * Keyed by allianceId.
 */
const offshoreHoldingsCache: Map<number, Record<string, number>> = new Map();

// ---------- small utils ----------
function pretty(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[, _]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

// ---------- resolve alliance for a guild ----------
async function findAllianceForGuild(guildId?: string) {
  if (!guildId) return null;
  const map = await prisma.allianceGuild.findUnique({ where: { guildId } });
  if (map) {
    const a = await prisma.alliance.findUnique({ where: { id: map.allianceId } });
    if (a) return a;
  }
  return await prisma.alliance.findFirst({ where: { guildId } });
}

// ---------- effective offshore ----------
async function resolveOffshoreAid(allianceId: number): Promise<{ effective: number | null, override: number | null, global: number | null }> {
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  const override = a?.offshoreOverrideAllianceId ?? null;
  const global = await getDefaultOffshore();
  const effective = override ?? global ?? null;
  return { effective, override, global };
}

// ---------- compute windowed net holdings ----------
async function computeWindowedHoldings(srcAllianceId: number, offshoreAid: number, take = 150) {
  // lower limit (150) for faster UX; bump to 300 later if needed
  const rows = await fetchBankrecs(offshoreAid, { limit: take });

  const A = String(srcAllianceId), O = String(offshoreAid);
  const sum: Record<string, number> = Object.fromEntries(RESOURCE_KEYS.map(k => [k, 0]));

  for (const r of rows) {
    const sType = Number((r as any).sender_type), sId = String((r as any).sender_id);
    const rType = Number((r as any).receiver_type), rId = String((r as any).receiver_id);

    const sAlliance = (sType === 2 || sType === 3) ? sId : null;
    const rAlliance = (rType === 2 || rType === 3) ? rId : null;

    // alliance -> offshore : add
    if (sAlliance === A && rAlliance === O) {
      for (const k of RESOURCE_KEYS) sum[k] += Number((r as any)[k] ?? 0);
    }
    // offshore -> alliance : subtract
    if (sAlliance === O && rAlliance === A) {
      for (const k of RESOURCE_KEYS) sum[k] -= Number((r as any)[k] ?? 0);
    }
  }

  return sum;
}

// ---------- /offshore command definition ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Manage and use alliance offshore")
  .addSubcommand(s => s
    .setName("show")
    .setDescription("Show which offshore is in effect for this alliance"))
  .addSubcommand(s => s
    .setName("set_default")
    .setDescription("BOT ADMIN: set the global default offshore alliance id")
    .addIntegerOption(o => o.setName("aid").setDescription("Alliance ID to set as the global default (or 0 to clear)").setRequired(true)))
  .addSubcommand(s => s
    .setName("set_override")
    .setDescription("Set or clear this alliance’s offshore override")
    .addIntegerOption(o => o.setName("aid").setDescription("Alliance ID (0 to clear)").setRequired(true)))
  .addSubcommand(s => s
    .setName("holdings")
    .setDescription("Show your alliance’s net holdings in your offshore (recent window, deduped)"))
  .addSubcommand(s => s
    .setName("send")
    .setDescription("Send from your alliance bank to the configured offshore (guided form, no JSON)"));

export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();

  const alliance = await findAllianceForGuild(i.guildId ?? undefined);
  if (!alliance) return i.reply({ content: "No alliance linked to this server. Run /setup_alliance first.", ephemeral: true });

  if (sub === "set_default") {
    const adminId = process.env.BOT_ADMIN_DISCORD_ID?.trim();
    if (!adminId) {
      return i.reply({ content: "⚠️ BOT_ADMIN_DISCORD_ID is not set. Ask the host to configure it.", ephemeral: true });
    }
    if (i.user.id !== adminId) {
      return i.reply({ content: "Only the bot admin can set the global default offshore.", ephemeral: true });
    }
    const aid = i.options.getInteger("aid", true) || 0;
    await setDefaultOffshore(aid > 0 ? aid : null, i.user.id);
    return i.reply({ content: `✅ Global default offshore set → **${aid}**.`, ephemeral: true });
  }

  if (sub === "set_override") {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ content: "You need Manage Server to set/clear an override.", ephemeral: true });
    }
    const aid = i.options.getInteger("aid", true) || 0;
    await prisma.alliance.update({
      where: { id: alliance.id },
      data: { offshoreOverrideAllianceId: aid || null },
    });
    return i.reply({ content: aid ? `✅ Override set to **${aid}**` : "✅ Override cleared.", ephemeral: true });
  }

  if (sub === "show") {
    const { effective, override, global } = await resolveOffshoreAid(alliance.id);

    const embed = new EmbedBuilder()
      .setTitle("🌊 Offshore Configuration")
      .setColor(Colors.Blurple)
      .addFields(
        { name: "Alliance", value: `${alliance.name || ""} (ID ${alliance.id})`, inline: false },
        { name: "Override", value: override ? `**${override}**` : "—", inline: true },
        { name: "Global default", value: global ? `**${global}**` : "—", inline: true },
        { name: "Effective offshore", value: effective ? `**${effective}**` : "—", inline: false },
      );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("📤").setLabel("Send to Offshore"),
      new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setEmoji("📊").setLabel("Show Holdings")
    );

    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  if (sub === "holdings") {
    await i.deferReply({ ephemeral: true }); // avoid timeouts
    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.editReply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default." });
    }

    try {
      const sum = await computeWindowedHoldings(alliance.id, offshoreAid, 150);
      offshoreHoldingsCache.set(alliance.id, sum); // cache for modal hints

      const lines = RESOURCE_KEYS
        .map(k => ({ k, v: sum[k] }))
        .filter(({ v }) => Math.abs(v) > 0)
        .map(({ k, v }) => `• **${k}**: ${pretty(v)}`);

      const embed = new EmbedBuilder()
        .setTitle("🏦 Offshore Holdings (windowed)")
        .setDescription(`**${alliance.name || alliance.id}** ↔ **${offshoreAid}**\nWindow: last 150 offshore bankrecs`)
        .addFields({ name: "Net (deposits - withdrawals)", value: lines.length ? lines.join("\n") : "— none in window —" })
        .setColor(Colors.Blurple);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("📤").setLabel("Send to Offshore"),
        new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setEmoji("📊").setLabel("Re-check holdings")
      );

      return i.editReply({ embeds: [embed], components: [row] });
    } catch (e) {
      console.error("[/offshore holdings] error", e);
      return i.editReply({ content: "Could not compute holdings right now." });
    }
  }

  // sub === "send"
  {
    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle("📤 Send to Offshore")
      .setDescription(`Destination offshore: **${offshoreAid}**\nUse **Start** to enter amounts (paged form).`)
      .setColor(Colors.Blurple);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("✨").setLabel("Start"),
      new ButtonBuilder().setCustomId("offsh:done").setStyle(ButtonStyle.Success).setEmoji("✅").setLabel("Done")
    );

    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }
}

// ---------- Button + Modal handlers (wired in index.ts) ----------
const SEND_PAGE_SIZE = 5;
function pageCount() { return Math.ceil(RESOURCE_KEYS.length / SEND_PAGE_SIZE); }
function sliceKeys(page: number) {
  const s = page * SEND_PAGE_SIZE;
  return RESOURCE_KEYS.slice(s, s + SEND_PAGE_SIZE);
}

const sendSessions: Map<string, { data: Record<string, number>, createdAt: number }> = new Map();

export async function handleButton(i: Interaction) {
  // Quick path for SHOW HOLDINGS button (so the interaction never times out)
  if (i.isButton() && i.customId === "offsh:check") {
    const bi = i as ButtonInteraction;
    try { await bi.deferUpdate(); } catch {}

    try {
      const alliance = await findAllianceForGuild(bi.guildId ?? undefined);
      if (!alliance) {
        return bi.followUp({ content: "No alliance linked to this server.", ephemeral: true });
      }
      const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
      if (!offshoreAid) {
        return bi.followUp({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
      }

      const sum = await computeWindowedHoldings(alliance.id, offshoreAid, 150);
      offshoreHoldingsCache.set(alliance.id, sum);

      const lines = RESOURCE_KEYS
        .map(k => ({ k, v: sum[k] }))
        .filter(({ v }) => Math.abs(v) > 0)
        .map(({ k, v }) => `• **${k}**: ${pretty(v)}`);

      const embed = new EmbedBuilder()
        .setTitle("🏦 Offshore Holdings (windowed)")
        .setDescription(`**${alliance.name || alliance.id}** ↔ **${offshoreAid}**\nWindow: last 150 offshore bankrecs`)
        .addFields({ name: "Net (deposits - withdrawals)", value: lines.length ? lines.join("\n") : "— none in window —" })
        .setColor(Colors.Blurple);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("📤").setLabel("Send to Offshore"),
        new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setEmoji("📊").setLabel("Re-check holdings"),
      );

      await bi.editReply({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error("[offsh:check] error", err);
      try { await (i as any).followUp?.({ content: "Something went wrong showing holdings.", ephemeral: true }); } catch {}
    }
    return;
  }

  if (!i.isButton()) return;

  if (i.customId.startsWith("offsh:open:")) {
    const m = i.customId.match(/^offsh:open:(\d+)$/);
    const page = m?.[1] ? Math.max(0, parseInt(m[1], 10)) : 0;
    return openSendModal(i as ButtonInteraction, page);
  }

  if (i.customId === "offsh:done") {
    const sess = sendSessions.get(i.user.id);
    if (!sess || !Object.keys(sess.data).length) {
      return (i as ButtonInteraction).reply({ content: "Nothing to send — enter some amounts first.", ephemeral: true });
    }

    // Resolve alliance & offshore
    const alliance = await findAllianceForGuild(i.guildId ?? undefined);
    if (!alliance) return (i as ButtonInteraction).reply({ content: "No alliance linked here.", ephemeral: true });

    const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return (i as ButtonInteraction).reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
    }

    // Try to send via GraphQL (needs API + bot key)
    try {
      const a = await prisma.alliance.findUnique({
        where: { id: alliance.id },
        include: { keys: { orderBy: { id: "desc" }, take: 1 } }
      });
      const apiKeyEnc = a?.keys?.[0];
      const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
      const botKey = process.env.PNW_BOT_KEY || "";

      const fields: string[] = Object.entries(sess.data)
        .filter(([, v]) => Number(v) > 0)
        .map(([k, v]) => `${k}:${Number(v)}`);

      const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${i.user.id}`;

      if (apiKey && botKey && fields.length) {
        const q = `mutation{
          bankWithdraw(receiver:${offshoreAid}, receiver_type:2, ${fields.join(",")}) { id }
        }`;
        const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": apiKey,
            "X-Bot-Key": botKey
          },
          body: JSON.stringify({ query: q })
        });
        const data = await res.json().catch(() => ({} as any));

        if (res.ok && !(data as any).errors && (data as any)?.data?.bankWithdraw) {
          sendSessions.delete(i.user.id);
          return (i as ButtonInteraction).reply({
            content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nVerify with **/offshore holdings** shortly.`,
            ephemeral: true
          });
        }

        console.error("OFFSH_SEND_ERR", res.status, JSON.stringify(data));
        // fall through to manual instructions
      }

      // Manual fallback (no keys or API failure)
      const embed = new EmbedBuilder()
        .setTitle("📤 Manual offshore transfer")
        .setDescription(`Use your **Alliance → Alliance** banker UI to send to **Alliance ${offshoreAid}**.\nPaste the note below.`)
        .addFields(
          { name: "Amounts", value: Object.entries(sess.data).map(([k, v]) => `• ${k}: ${pretty(Number(v))}`).join("\n") || "—" },
          { name: "Note", value: note }
        )
        .setColor(Colors.Orange);
      await (i as ButtonInteraction).reply({ embeds: [embed], ephemeral: true });
      sendSessions.delete(i.user.id);
    } catch (err) {
      console.error("[offsh:done] send error", err);
      return (i as ButtonInteraction).reply({ content: "Something went wrong sending to offshore.", ephemeral: true });
    }
  }
}

async function openSendModal(i: ButtonInteraction, page: number) {
  const alliance = await findAllianceForGuild(i.guildId ?? undefined);
  if (!alliance) return i.reply({ content: "No alliance linked here.", ephemeral: true });

  // Show BEST AVAILABLE estimate for availability:
  // 1) last computed windowed holdings (from /offshore holdings or Show Holdings button)
  //    This is NOT exact AA-bank balance, but helpful context.
  const est = offshoreHoldingsCache.get(alliance.id) || {};
  const total = pageCount();
  const keys = sliceKeys(page);

  const modal = new ModalBuilder().setCustomId(`offsh:modal:${page}`).setTitle(`📤 Offshore Send (${page + 1}/${total})`);
  for (const k of keys) {
    const hint = est[k] != null ? `est: ${pretty(Number(est[k] || 0))}` : "est: —";
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${k} (${hint})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder("0");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  await i.showModal(modal);
}

export async function handleModal(i: Interaction) {
  if (!i.isModalSubmit()) return;
  if (!i.customId.startsWith("offsh:modal:")) return;

  const m = i.customId.match(/^offsh:modal:(\d+)$/);
  const page = m?.[1] ? Math.max(0, parseInt(m[1], 10)) : 0;

  const keys = sliceKeys(page);
  const sess = sendSessions.get(i.user.id) || { data: {}, createdAt: Date.now() };

  for (const k of keys) {
    const raw = (i as any).fields.getTextInputValue(k) || "";
    const num = parseNum(raw);
    if (Number.isNaN(num) || num < 0) {
      return (i as any).reply({ content: `Invalid number for ${k}.`, ephemeral: true });
    }
    if (num > 0) sess.data[k] = num; else delete sess.data[k];
  }
  sendSessions.set(i.user.id, sess);

  const total = pageCount();
  const btns: ButtonBuilder[] = [];
  if (page > 0) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel("◀ Prev"));
  if (page < total - 1) btns.push(new ButtonBuilder().setCustomId(`offsh:open:${page + 1}`).setStyle(ButtonStyle.Primary).setLabel(`Next (${page + 2}/${total}) ▶`));
  btns.push(new ButtonBuilder().setCustomId("offsh:done").setStyle(ButtonStyle.Success).setLabel("Done ✅"));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
  const summary = Object.entries(sess.data).map(([k, v]) => `• ${k}: ${pretty(Number(v))}`).join("\n") || "— none yet —";
  await (i as any).reply({ content: `Saved so far:\n${summary}`, components: [row], ephemeral: true });
}
