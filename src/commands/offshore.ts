// src/commands/offshore.ts
// Offshore controller: show / set default / set override / holdings / send (modal)

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
  ButtonInteraction,
  Interaction,
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

type ResourceKey = (typeof RESOURCE_KEYS)[number];

// ---------- effective offshore ----------
async function resolveOffshoreAid(allianceId: number): Promise<{ effective: number | null; override: number | null; global: number | null }> {
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    select: { offshoreOverrideAllianceId: true },
  });
  const override = a?.offshoreOverrideAllianceId ?? null;
  const global = await getDefaultOffshore();
  return { effective: override ?? global ?? null, override, global };
}

// ---------- command data ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore controls")
  .addSubcommand((s) =>
    s
      .setName("show")
      .setDescription("Show which offshore is in effect for this alliance")
  )
  .addSubcommand((s) =>
    s
      .setName("set_default")
      .setDescription("BOT ADMIN: set the global default offshore alliance id")
      .addIntegerOption((o) =>
        o.setName("aid").setDescription("Alliance ID (blank to clear)").setRequired(false)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("set_override")
      .setDescription("Set or clear this alliance’s offshore override")
      .addIntegerOption((o) =>
        o.setName("aid").setDescription("Alliance ID (blank to clear)").setRequired(false)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("holdings")
      .setDescription("Show your alliance’s net holdings in your offshore (recent window, deduped)")
  )
  .addSubcommand((s) =>
    s
      .setName("send")
      .setDescription("Send from your alliance bank to the configured offshore (guided form, no JSON)")
  );

// ---------- slash execute ----------
export async function execute(i: ChatInputCommandInteraction) {
  if (!i.guildId) return i.reply({ content: "Guild only.", ephemeral: true });

  // resolve alliance linked to this guild
  const map = await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } });
  const alliance = map
    ? await prisma.alliance.findUnique({ where: { id: map.allianceId } })
    : await prisma.alliance.findFirst({ where: { guildId: i.guildId } });
  if (!alliance) {
    return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
  }

  const sub = i.options.getSubcommand(true);

  if (sub === "show") {
    const { effective, override, global } = await resolveOffshoreAid(alliance.id);

    const embed = new EmbedBuilder()
      .setTitle("🏝️ Offshore Configuration")
      .setColor(Colors.Blurple)
      .addFields(
        { name: "Alliance", value: `${alliance.name || alliance.id}`, inline: true },
        { name: "Override", value: override ? `**${override}**` : "—", inline: true },
        { name: "Global Default", value: global ? `**${global}**` : "—", inline: true },
        { name: "Effective offshore", value: effective ? `**${effective}**` : "—", inline: false },
      );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("offsh:open:0").setStyle(ButtonStyle.Primary).setEmoji("📤").setLabel("Send to Offshore"),
      new ButtonBuilder().setCustomId("offsh:check").setStyle(ButtonStyle.Secondary).setEmoji("📊").setLabel("Show Holdings"),
    );

    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  if (sub === "set_default") {
    const actor = i.user.id;
    const adminId = process.env.BOT_ADMIN_DISCORD_ID;
    if (!adminId) {
      return i.reply({ content: "⚠️ BOT_ADMIN_DISCORD_ID is not set. Ask the host to configure it.", ephemeral: true });
    }
    if (actor !== adminId) {
      return i.reply({ content: "Only the bot admin can set the global default offshore.", ephemeral: true });
    }
    const aid = i.options.getInteger("aid", false) ?? null;
    await setDefaultOffshore(aid, actor);
    return i.reply({ content: `✅ Global default offshore set → **${aid ?? "cleared"}**.`, ephemeral: true });
  }

  if (sub === "set_override") {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ content: "You lack permission to change the override.", ephemeral: true });
    }
    const aid = i.options.getInteger("aid", false);
    await prisma.alliance.update({
      where: { id: alliance.id },
      data: { offshoreOverrideAllianceId: aid || null },
    });
    return i.reply({ content: `✅ Offshore override ${aid ? `set to **${aid}**` : "cleared"}.`, ephemeral: true });
  }

  if (sub === "holdings") {
    return showHoldingsImmediate(i, alliance);
  }

  if (sub === "send") {
    // show start card w/ Start button → modal (no reply/defer before showModal)
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

// ---------- buttons / modal routing ----------
export async function handleButton(i: Interaction) {
  if (!i.isButton()) return;

  // resolve alliance linked to this guild
  const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
  const alliance = map
    ? await prisma.alliance.findUnique({ where: { id: map.allianceId } })
    : (i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null);
  if (!alliance) {
    return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
  }

  if (i.customId === "offsh:check") {
    return showHoldingsImmediate(i, alliance);
  }

  // OPEN WIZARD PAGE (button -> modal): DO NOT defer/reply before showModal
  if (i.customId.startsWith("offsh:open:")) {
    const m = i.customId.match(/^offsh:open:(\d+)$/);
    const page = m ? Math.max(0, parseInt(m[1], 10)) : 0;
    return openSendModal(i as ButtonInteraction, page);
  }

  if (i.customId === "offsh:done") {
    await i.deferReply({ ephemeral: true });
    // Nothing persisted during paging; this is a UX end-cap.
    await i.editReply({ content: "Close the modal flow and submit via your banker once confirmed." });
  }
}

export async function handleModal(i: Interaction) {
  if (!i.isModalSubmit()) return;
  if (!i.customId.startsWith("offsh:modal:")) return;

  // resolve alliance linked to this guild
  const map = i.guildId ? await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId } }) : null;
  const alliance = map
    ? await prisma.alliance.findUnique({ where: { id: map.allianceId } })
    : (i.guildId ? await prisma.alliance.findFirst({ where: { guildId: i.guildId } }) : null);
  if (!alliance) {
    return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
  }

  await handleSendModalSubmit(i as any, alliance);
}

// ---------- holdings ----------
async function showHoldingsImmediate(i: ChatInputCommandInteraction | ButtonInteraction, alliance: { id: number; name: string | null }) {
  await i.deferReply({ ephemeral: true });

  const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
  if (!offshoreAid) {
    return i.editReply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default." });
  }

  // Take last N bankrecs on OFFSHORE, compute net A->O minus O->A (alliance↔alliance transfers only)
  const take = 300;
  try {
    const rows = await fetchBankrecs(offshoreAid, { limit: take });

    const A = String(alliance.id);
    const O = String(offshoreAid);

    const totals: Record<ResourceKey, number> = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0])) as any;

    for (const r of rows) {
      // only consider alliance<->alliance traffic
      const st = Number((r as any).sender_type);
      const rt = Number((r as any).receiver_type);
      if (st !== 2 || rt !== 2) continue;

      const sid = String((r as any).sender_id);
      const rid = String((r as any).receiver_id);

      let sign = 0;
      if (sid === A && rid === O) sign = +1;       // A -> O (deposit)
      else if (sid === O && rid === A) sign = -1;  // O -> A (withdraw)
      else continue;

      for (const key of RESOURCE_KEYS) {
        const amt = Number((r as any)[key] ?? 0);
        if (amt > 0) totals[key] += sign * amt;
      }
    }

    const fields = RESOURCE_KEYS
      .map((k) => ({ k, v: totals[k] }))
      .filter(({ v }) => Math.abs(v) > 0)
      .map(({ k, v }) => ({ name: `• ${k}`, value: (v >= 0 ? "+" : "−") + fmt(Math.abs(v)), inline: true }));

    const embed = new EmbedBuilder()
      .setTitle("📊 Offshore Holdings (net)")
      .setColor(Colors.Blurple)
      .setDescription(`**${alliance.name || alliance.id}** ↔ **${offshoreAid}**\nWindow: last ${take} bankrecs on offshore`)
      .addFields(fields.length ? fields : [{ name: "—", value: "No net holdings in the recent window.", inline: false }]);

    await i.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("OFFSH_HOLDINGS_ERR", err);
    await i.editReply({ content: "Failed to compute holdings. Try again shortly." });
  }
}

// ---------- send flow (modal) ----------
const PAGE_SIZE = 5;
function pageCountAll() { return Math.ceil(RESOURCE_KEYS.length / PAGE_SIZE); }
function sliceAll(page: number) { const s = page * PAGE_SIZE; return RESOURCE_KEYS.slice(s, s + PAGE_SIZE); }

async function openSendModal(i: ButtonInteraction, page: number) {
  // IMPORTANT: do not defer or reply prior to showModal()
  const total = pageCountAll();
  const keys = sliceAll(page);

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

  await i.showModal(modal);
}

async function handleSendModalSubmit(i: any, alliance: { id: number }) {
  // parse page
  const m = String(i.customId).match(/^offsh:modal:(\d+)$/);
  if (!m) return;
  const page = Number(m[1]);

  const { effective: offshoreAid } = await resolveOffshoreAid(alliance.id);
  if (!offshoreAid) {
    return i.reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
  }

  const keys = sliceAll(page);
  const amounts: Record<string, number> = {};
  for (const k of keys) {
    const raw = (i.fields.getTextInputValue(k) || "").trim();
    if (raw === "") continue;
    const num = parseNum(raw);
    if (!Number.isFinite(num) || num < 0) {
      return i.reply({ content: `Invalid number for ${k}.`, ephemeral: true });
    }
    if (num > 0) amounts[k] = num;
  }

  // If nothing on this page, just ack
  if (!Object.keys(amounts).length) {
    return i.reply({ content: `Saved page ${page + 1}. Use the **Next/Prev** buttons to continue.`, ephemeral: true });
  }

  // Try to auto-send (requires valid alliance API key)
  try {
    const apiKey = await getAllianceApiKeyFor(alliance.id);
    const botKey = process.env.PNW_BOT_KEY || "";
    if (!apiKey || !botKey) {
      // Fallback UX: show manual note
      return manualSendFallback(i, alliance.id, offshoreAid, amounts);
    }

    // Build mutation
    const fields = Object.entries(amounts)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${k}:${Number(v)}`);
    const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${i.user.id}`;
    if (note) fields.push(`note:${JSON.stringify(note)}`);

    const q = `mutation{
      bankWithdraw(receiver:${offshoreAid}, receiver_type:2, ${fields.join(",")}) { id }
    }`;

    const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Bot-Key": botKey,
      },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json().catch(() => ({} as any));
    if (!res.ok || (data as any).errors) {
      console.error("OFFSH_SEND_ERR", res.status, JSON.stringify(data));
      return manualSendFallback(i, alliance.id, offshoreAid, amounts);
    }

    const pretty = Object.entries(amounts).map(([k, v]) => `• ${k}: ${fmt(Number(v))}`).join("\n");
    return i.reply({
      content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nVerify with **/offshore holdings** shortly.\n\n**Amounts**\n${pretty}`,
      ephemeral: true,
    });
  } catch (err) {
    console.error("OFFSH_SEND_ERR_THROW", err);
    return manualSendFallback(i, alliance.id, offshoreAid, amounts);
  }
}

async function manualSendFallback(i: any, srcAid: number, offshoreAid: number, amounts: Record<string, number>) {
  const note = `Gemstone Offsh • src ${srcAid} -> off ${offshoreAid} • by ${i.user.id}`;
  const pretty = Object.entries(amounts).map(([k, v]) => `• ${k}: ${fmt(Number(v))}`).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("📤 Manual offshore transfer")
    .setDescription(`Use your **Alliance → Alliance** banker UI to send to **Alliance ${offshoreAid}**.\nPaste the note below.`)
    .addFields(
      { name: "Amounts", value: pretty || "—", inline: false },
      { name: "Note", value: `\`${note}\``, inline: false }
    )
    .setColor(Colors.Gold);

  return i.reply({ embeds: [embed], ephemeral: true });
}

// ---------- API key (newest→oldest) ----------
async function getAllianceApiKeyFor(aid: number): Promise<string | null> {
  const alliance = await prisma.alliance.findUnique({
    where: { id: aid },
    include: { keys: { orderBy: { id: "desc" } } }
  });
  const keys = alliance?.keys ?? [];
  for (const k of keys) {
    try {
      const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
      if (apiKey && apiKey.length > 10) return apiKey;
    } catch {
      // ignore this record
    }
  }
  return null;
}
