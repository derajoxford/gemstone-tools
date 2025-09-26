// src/commands/safekeeping_adjust.ts
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

const prisma = new PrismaClient();

const RESOURCE_KEYS = [
  "money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

function hasBankerRoleOrAdmin(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((r) => r.name.toLowerCase() === "banker");
}

async function resolveAllianceAndMember(opts: {
  discordUserId?: string | null;
  nationId?: number | null;
}) {
  const { discordUserId, nationId } = opts;
  const memberRecord = await prisma.member.findFirst({
    where: {
      OR: [
        discordUserId ? { discordUserId } : undefined,
        nationId ? { nationId } : undefined,
      ].filter(Boolean) as any,
    },
    orderBy: { id: "desc" },
  });
  if (!memberRecord) return { allianceId: null as number | null, member: null as any };
  return { allianceId: memberRecord.allianceId as number, member: memberRecord };
}

async function applyManualAdjust(opts: {
  allianceId: number;
  memberId: number;
  resource: ResourceKey;
  delta: number;
  actorDiscordId: string;
  reason?: string | null;
}) {
  const { allianceId, memberId, resource, delta, actorDiscordId, reason } = opts;
  const [safe] = await prisma.$transaction(async (tx) => {
    const safe = await tx.safekeeping.upsert({
      where: { memberId_allianceId: { memberId, allianceId } },
      update: { [resource]: { increment: delta } as any },
      create: {
        allianceId, memberId,
        money: 0, food: 0, coal: 0, oil: 0, uranium: 0, lead: 0, iron: 0, bauxite: 0,
        gasoline: 0, munitions: 0, steel: 0, aluminum: 0,
        [resource]: delta,
      } as any,
    });
    await tx.safeTxn.create({
      data: {
        allianceId, memberId, resource, amount: delta,
        type: "MANUAL_ADJUST",
        actorDiscordId, reason: reason ?? null,
      } as any,
    });
    return [safe];
  });
  return safe;
}

export const data = new SlashCommandBuilder()
  .setName("safekeeping_adjust")
  .setDescription("Bankers: add or subtract resources in a member's safekeeping.")
  .addSubcommand((sub) =>
    sub.setName("add").setDescription("Add resources")
      .addUserOption(o => o.setName("member").setDescription("Discord user").setRequired(false))
      .addIntegerOption(o => o.setName("nation_id").setDescription("Target by nation ID").setRequired(false))
      .addStringOption(o => o.setName("resource").setDescription("Resource").setRequired(true)
        .addChoices(...RESOURCE_KEYS.map(k => ({ name: k, value: k }))))
      .addNumberOption(o => o.setName("amount").setDescription("Amount (positive)").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Audit note").setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName("subtract").setDescription("Subtract resources")
      .addUserOption(o => o.setName("member").setDescription("Discord user").setRequired(false))
      .addIntegerOption(o => o.setName("nation_id").setDescription("Target by nation ID").setRequired(false))
      .addStringOption(o => o.setName("resource").setDescription("Resource").setRequired(true)
        .addChoices(...RESOURCE_KEYS.map(k => ({ name: k, value: k }))))
      .addNumberOption(o => o.setName("amount").setDescription("Amount (positive)").setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Audit note").setRequired(false))
  )
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  const guild = i.guild;
  const invoker = guild ? await guild.members.fetch(i.user.id).catch(() => null) : null;

  if (!hasBankerRoleOrAdmin(invoker)) {
    return i.editReply("You must have the **Banker** role (or be an Admin) to use this command.");
  }

  const sub = i.options.getSubcommand(true);
  const targetUser = i.options.getUser("member");
  const nationId = i.options.getInteger("nation_id");
  const resource = i.options.getString("resource", true) as ResourceKey;

  if (!((RESOURCE_KEYS as readonly string[]).includes(resource))) {
    return i.editReply(`Resource must be one of: ${RESOURCE_KEYS.join(", ")}`);
  }

  const raw = i.options.getNumber("amount", true);
  if (raw <= 0) return i.editReply("Amount must be a positive number.");
  const delta = sub === "subtract" ? -Math.abs(raw) : Math.abs(raw);
  const reason = i.options.getString("reason") ?? null;

  const { allianceId, member } = await resolveAllianceAndMember({
    discordUserId: targetUser?.id ?? null,
    nationId: nationId ?? null,
  });
  if (!member || !allianceId) {
    return i.editReply("Could not resolve the target member/alliance. Make sure the user is linked in the DB.");
  }

  const safe = await applyManualAdjust({
    allianceId,
    memberId: member.id,
    resource,
    delta,
    actorDiscordId: i.user.id,
    reason,
  });

  const newValue = (safe as any)[resource] as number;

  // Ephemeral confirmation for the banker
  const embed = new EmbedBuilder()
    .setTitle("Safekeeping Adjusted")
    .setDescription(`${delta >= 0 ? "Added" : "Subtracted"} **${Math.abs(delta)} ${resource}** for <@${member.discordUserId}>`)
    .addFields(
      { name: "Alliance ID", value: String(allianceId), inline: true },
      { name: "Member ID", value: String(member.id), inline: true },
      { name: "Delta", value: String(delta), inline: true },
      { name: "New Balance", value: String(newValue), inline: true },
      reason ? { name: "Reason", value: reason, inline: false } : undefined as any
    )
    .setTimestamp();

  await i.editReply({ embeds: [embed] });

  // Public log in configured channel
  if (guild) {
    const chId = await getGuildSetting(guild.id, "manual_adjust_log_channel_id");
    if (chId) {
      const ch = guild.channels.cache.get(chId) as TextChannel | undefined;
      if (ch?.isTextBased()) {
        const log = new EmbedBuilder()
          .setTitle("Manual Safekeeping Adjustment")
          .setDescription(`<@${i.user.id}> ${delta >= 0 ? "added" : "subtracted"} **${Math.abs(delta)} ${resource}** for <@${member.discordUserId}>`)
          .addFields(
            { name: "Alliance ID", value: String(allianceId), inline: true },
            { name: "Member ID", value: String(member.id), inline: true },
            { name: "Delta", value: String(delta), inline: true },
            { name: "New Balance", value: String(newValue), inline: true },
            reason ? { name: "Reason", value: reason, inline: false } : undefined as any
          )
          .setTimestamp();
        await ch.send({ embeds: [log] }).catch(() => {});
      }
    }
  }
}

export default { data, execute };
