import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  GuildMember,
  TextChannel,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { getGuildSetting } from "../utils/settings.js";
import {
  RESOURCE_KEYS,
  type ResourceKey,
  RESOURCE_META,
  COLORS,
  fmtAmount,
  resourceLabel,
  colorForDelta,
} from "../utils/pretty.js";

const prisma = new PrismaClient();

function hasBankerRoleOrAdmin(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((r) => r.name.toLowerCase() === "banker");
}

async function findMemberByDiscordId(discordId: string | null) {
  if (!discordId) return null;
  return prisma.member.findFirst({ where: { discordId }, orderBy: { id: "desc" } });
}
async function findMemberByNationId(nationId: number | null) {
  if (nationId == null) return null;
  return prisma.member.findFirst({ where: { nationId }, orderBy: { id: "desc" } });
}

export const data = new SlashCommandBuilder()
  .setName("safekeeping_adjust")
  .setDescription("Bankers: add or subtract resources in a member's safekeeping.")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add resources")
      .addStringOption((o) =>
        o.setName("resource").setDescription("Resource").setRequired(true)
          .addChoices(...RESOURCE_KEYS.map((k) => ({ name: k, value: k })))
      )
      .addNumberOption((o) => o.setName("amount").setDescription("Amount (positive)").setRequired(true))
      .addUserOption((o) => o.setName("member").setDescription("Discord user").setRequired(false))
      .addIntegerOption((o) => o.setName("nation_id").setDescription("Target by nation ID").setRequired(false))
      .addStringOption((o) => o.setName("reason").setDescription("Audit note").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName("subtract")
      .setDescription("Subtract resources")
      .addStringOption((o) =>
        o.setName("resource").setDescription("Resource").setRequired(true)
          .addChoices(...RESOURCE_KEYS.map((k) => ({ name: k, value: k })))
      )
      .addNumberOption((o) => o.setName("amount").setDescription("Amount (positive)").setRequired(true))
      .addUserOption((o) => o.setName("member").setDescription("Discord user").setRequired(false))
      .addIntegerOption((o) => o.setName("nation_id").setDescription("Target by nation ID").setRequired(false))
      .addStringOption((o) => o.setName("reason").setDescription("Audit note").setRequired(false))
  )
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  try {
    await i.deferReply({ ephemeral: true });

    const guild = i.guild;
    const invoker = guild ? await guild.members.fetch(i.user.id).catch(() => null) : null;
    if (!hasBankerRoleOrAdmin(invoker)) {
      return i.editReply("You must have the **Banker** role (or be an Admin) to use this command.");
    }

    const sub = i.options.getSubcommand(true);
    const resource = i.options.getString("resource", true) as ResourceKey;
    const raw = i.options.getNumber("amount", true);
    const targetUser = i.options.getUser("member");
    const nationId = i.options.getInteger("nation_id");
    const reason = i.options.getString("reason") ?? null;

    if (!(RESOURCE_KEYS as readonly string[]).includes(resource)) {
      return i.editReply(`Resource must be one of: ${RESOURCE_KEYS.join(", ")}`);
    }
    if (raw <= 0) return i.editReply("Amount must be a positive number.");
    const delta = sub === "subtract" ? -Math.abs(raw) : Math.abs(raw);

    // Resolve target
    const member =
      (await findMemberByDiscordId(targetUser?.id ?? null)) ??
      (await findMemberByNationId(nationId ?? null)) ??
      (await findMemberByDiscordId(i.user.id));
    if (!member) {
      return i.editReply("Could not resolve the target member. Make sure the user is linked in the DB, or specify `member` / `nation_id`.");
    }

    // Write balance + audit (audit best-effort)
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.safekeeping.findUnique({ where: { memberId: member.id } });
      const safeRow = existing
        ? await tx.safekeeping.update({ where: { id: existing.id }, data: { [resource]: { increment: delta } as any } })
        : await tx.safekeeping.create({
            data: {
              memberId: member.id,
              money: 0, food: 0, coal: 0, oil: 0, uranium: 0, lead: 0, iron: 0, bauxite: 0,
              gasoline: 0, munitions: 0, steel: 0, aluminum: 0,
              [resource]: delta,
            } as any,
          });

      const anyTx = tx as any;
      if (anyTx.safeTxn?.create) {
        await anyTx.safeTxn.create({
          data: {
            memberId: member.id,
            resource,
            amount: delta,
            type: "MANUAL_ADJUST",
            actorDiscordId: i.user.id,
            reason: reason ?? null,
          },
        }).catch(() => {});
      }

      return safeRow;
    });

    const newValue = Number((updated as any)[resource] ?? 0);
    const meta = RESOURCE_META[resource];
    const color = colorForDelta(delta, meta?.color ?? COLORS.blurple);
    const guildIcon = guild?.iconURL?.() ?? undefined;

    const prettyChange = `${delta >= 0 ? "➕" : "➖"} ${fmtAmount(Math.abs(delta))} ${meta.emoji}`;
    const prettyBalance = `${fmtAmount(newValue)} ${meta.emoji}`;

    // Build fields safely (no undefined entries)
    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: "Change", value: prettyChange, inline: true },
      { name: "New Balance", value: prettyBalance, inline: true },
      { name: "By", value: `<@${i.user.id}>`, inline: true },
    ];
    if (reason) fields.push({ name: "Reason", value: reason, inline: false });

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: "Safekeeping Adjusted", iconURL: guildIcon })
      .setTitle(resourceLabel(resource))
      .setDescription(`For <@${member.discordId}>`)
      .addFields(fields)
      .setTimestamp();

    await i.editReply({ embeds: [embed] });

    // Log channel
    if (guild) {
      const chId = await getGuildSetting(guild.id, "manual_adjust_log_channel_id");
      if (chId) {
        const ch = guild.channels.cache.get(chId) as TextChannel | undefined;
        if (ch?.isTextBased()) {
          const logFields: { name: string; value: string; inline?: boolean }[] = [
            { name: "Change", value: prettyChange, inline: true },
            { name: "New Balance", value: prettyBalance, inline: true },
          ];
          if (reason) logFields.push({ name: "Reason", value: reason, inline: false });

          const log = new EmbedBuilder()
            .setColor(color)
            .setAuthor({ name: "Manual Safekeeping Adjustment", iconURL: guildIcon })
            .setTitle(resourceLabel(resource))
            .setDescription(`<@${i.user.id}> ${delta >= 0 ? "added" : "subtracted"} **${fmtAmount(Math.abs(delta))} ${meta.emoji}** for <@${member.discordId}>`)
            .addFields(logFields)
            .setTimestamp();
          await ch.send({ embeds: [log] }).catch(() => {});
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
    try {
      if (i.deferred || i.replied) await i.editReply(`❌ Error: ${msg}`);
      else await i.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
    } catch {}
    console.error("safekeeping_adjust error:", err);
  }
}

export default { data, execute };
