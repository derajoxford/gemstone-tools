// src/commands/offshore.ts
import {
  SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits,
  EmbedBuilder, Colors, ButtonBuilder, ActionRowBuilder, ButtonStyle
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecs, RESOURCE_KEYS, asNum } from "../lib/pnw";
import { getDefaultOffshore, setDefaultOffshore } from "../lib/offshore";
import { open } from "../lib/crypto";

const prisma = new PrismaClient();

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
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

async function resolveOffshoreAid(allianceId: number): Promise<number | null> {
  const a = await prisma.alliance.findUnique({ where: { id: allianceId } });
  if (a?.offshoreOverrideAllianceId) return a.offshoreOverrideAllianceId;
  return await getDefaultOffshore();
}

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
    .setDescription("Show your alliance’s net holdings in your offshore (live, deduped by bankrec id)"))
  .addSubcommand(sc => sc
    .setName("send")
    .setDescription("Prepare an alliance-bank → offshore transfer (manual by default)")
    .addStringOption(o => o
      .setName("payload_json")
      .setDescription('e.g. {"money":1000000,"steel":500}')
      .setRequired(true)))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand(true);

  if (sub === "set_default") {
    // bot-admin only
    const adminId = process.env.BOT_ADMIN_DISCORD_ID?.trim();
    if (!adminId || i.user.id !== adminId) {
      return i.reply({ content: "only the bot admin can set the global default offshore", ephemeral: true });
    }
    const aid = i.options.getInteger("aid", true);
    await setDefaultOffshore(aid, i.user.id);
    return i.reply({ content: `✅ Set global default offshore to alliance ${aid}.`, ephemeral: true });
  }

  // resolve calling alliance
  const ag = await prisma.allianceGuild.findUnique({ where: { guildId: i.guildId! } });
  const alliance = ag
    ? await prisma.alliance.findUnique({ where: { id: ag.allianceId } })
    : await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? "" } });

  if (!alliance) {
    return i.reply({ content: "This server is not linked to an alliance. Use /guild_link_alliance or /setup_alliance.", ephemeral: true });
  }

  if (sub === "show") {
    const globalAid = await getDefaultOffshore();
    const eff = await resolveOffshoreAid(alliance.id);
    const lines = [
      `Alliance: **${alliance.name || alliance.id}** (id ${alliance.id})`,
      `Per-alliance override: ${alliance.offshoreOverrideAllianceId ? `**${alliance.offshoreOverrideAllianceId}**` : "_none_"} `,
      `Global default: ${globalAid ? `**${globalAid}**` : "_none set_"} `,
      `Effective offshore: **${eff ?? "—"}**`,
    ].join("\n");
    return i.reply({ content: lines, ephemeral: true });
  }

  if (sub === "set_override") {
    const aid = i.options.getInteger("aid", false) ?? 0;
    await prisma.alliance.update({
      where: { id: alliance.id },
      data: { offshoreOverrideAllianceId: aid || null },
    });
    return i.reply({ content: aid ? `✅ Offshore override set → ${aid}` : "✅ Offshore override cleared.", ephemeral: true });
  }

  if (sub === "holdings") {
    const offshoreAid = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
    }
    await i.deferReply({ ephemeral: true });

    // Pull a big window and dedupe by id
    const take = 400; // recent history window on the OFFSHORE alliance
    const rows = await fetchBankrecs(offshoreAid, { limit: take });

    const net: Record<string, number> = {};
    for (const k of RESOURCE_KEYS) net[k] = 0;

    // count A -> O as positive; O -> A as negative
    const A = String(alliance.id), O = String(offshoreAid);
    const seen = new Set<string>();

    for (const r of rows) {
      if (seen.has(String(r.id))) continue;
      seen.add(String(r.id));

      const fromAtoO = r.sender_type === 2 && String(r.sender_id) === A && r.receiver_type === 2 && String(r.receiver_id) === O;
      const fromOtoA = r.sender_type === 2 && String(r.sender_id) === O && r.receiver_type === 2 && String(r.receiver_id) === A;
      if (!fromAtoO && !fromOtoA) continue;

      const sign = fromAtoO ? +1 : -1;
      for (const k of RESOURCE_KEYS) {
        net[k] = (net[k] || 0) + sign * asNum((r as any)[k]);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("🏦 Offshore Holdings (derived from bankrecs)")
      .setDescription(`Source **${alliance.name || alliance.id}** → Offshore **${offshoreAid}**\nWindow: last ${take} bankrecs on offshore.`)
      .addFields({ name: "Net amounts", value: resLines(net) })
      .setColor(Colors.Blurple);

    return i.editReply({ embeds: [embed] });
  }

  if (sub === "send") {
    const offshoreAid = await resolveOffshoreAid(alliance.id);
    if (!offshoreAid) {
      return i.reply({ content: "No offshore set. Use /offshore set_override or ask the bot admin to set a global default.", ephemeral: true });
    }

    // parse payload
    let payload: Record<string, number>;
    try {
      payload = JSON.parse(i.options.getString("payload_json", true));
      for (const [k, v] of Object.entries(payload)) {
        if (!RESOURCE_KEYS.includes(k as any)) throw new Error(`bad key ${k}`);
        if (!Number.isFinite(Number(v)) || Number(v) <= 0) throw new Error(`bad amount for ${k}`);
      }
    } catch (e: any) {
      return i.reply({ content: `Invalid JSON: ${e?.message || e}`, ephemeral: true });
    }

    const tryAuto = process.env.AUTOOFFSHORE_ENABLED === "1";
    if (tryAuto) {
      const krec = await prisma.allianceKey.findFirst({
        where: { allianceId: alliance.id },
        orderBy: { id: "desc" }
      });
      const apiKey = krec ? open(krec.encryptedApiKey as any, krec.nonceApi as any)
        : (process.env[`PNW_API_KEY_${alliance.id}`] || process.env.PNW_API_KEY || "");
      const botKey = process.env.PNW_BOT_KEY || "";

      if (apiKey && botKey) {
        const fields: string[] = Object.entries(payload).map(([k, v]) => `${k}:${Number(v)}`);
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
          return i.reply({
            content: `✅ Sent to offshore **${offshoreAid}**.\nNote: \`${note}\`\nVerify with **/offshore holdings** shortly.`,
            ephemeral: true
          });
        }
        // fall through to manual if auto failed
        await i.reply({ content: "⚠️ Auto-send failed. See manual instructions below.", ephemeral: true });
      } else {
        await i.reply({ content: "⚠️ No API/Bot key found for this alliance. Using manual method below.", ephemeral: true });
      }
    }

    // Manual instructions
    const note = `Gemstone Offsh • src ${alliance.id} -> off ${offshoreAid} • by ${i.user.id}`;
    const list = RESOURCE_KEYS
      .map(k => payload[k] ? `• ${k}: ${fmt(Number(payload[k]))}` : null)
      .filter(Boolean)
      .join("\n") || "— none —";

    const embed = new EmbedBuilder()
      .setTitle("📤 Manual offshore transfer")
      .setDescription(`Use your alliance banker UI to send to **Alliance ${offshoreAid}** (receiver type **Alliance**). Paste the note below.`)
      .addFields(
        { name: "Send these amounts", value: list },
        { name: "Note", value: "```" + note + "```" }
      )
      .setColor(Colors.Gold);

    // add a tiny helper button to re-check holdings after a bit
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("offshore:check").setStyle(ButtonStyle.Secondary).setLabel("Re-check holdings (run /offshore holdings)")
    );

    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  return i.reply({ content: "Unknown subcommand.", ephemeral: true });
}
