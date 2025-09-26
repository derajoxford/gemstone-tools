// src/commands/safekeeping_adjust.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  GuildMember,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Keep this in sync with your resource set used in Treasury/Safekeeping
const RESOURCE_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

function hasBankerRoleOrAdmin(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((r) => r.name.toLowerCase() === "banker");
}

async function resolveAllianceAndMember(opts: {
  guildId: string;
  discordUserId?: string | null;
  nationId?: number | null;
}) {
  const { guildId, discordUserId, nationId } = opts;

  // First, find alliance by guild (your schema usually associates Members to an Alliance which maps to a guild)
  // If you store allianceId on Member only, we infer via the target Member.
  const memberRecord = await prisma.member.findFirst({
    where: {
      OR: [
        discordUserId ? { discordUserId } : undefined,
        nationId ? { nationId } : undefined,
      ].filter(Boolean) as any,
    },
    orderBy: { id: "desc" },
  });

  if (!memberRecord) {
    return { allianceId: null as number | null, member: null as any };
  }

  return { allianceId: memberRecord.allianceId as number, member: memberRecord };
}

async function applyManualAdjust(opts: {
  allianceId: number;
  memberId: number;
  resource: ResourceKey;
  delta: number; // positive or negative
  actorDiscordId: string;
  reason?: string | null;
}) {
  const { allianceId, memberId, resource, delta, actorDiscordId, reason } = opts;

  // Use a transaction for atomicity: update Safekeeping then insert SafeTxn
  const [safe] = await prisma.$transaction(async (tx) => {
    // Upsert safekeeping row
    const safe = await tx.safekeeping.upsert({
      where: { memberId_allianceId: { memberId, allianceId } },
      update: { [resource]: { increment: delta } as any },
      create: {
        allianceId,
        memberId,
        // initialize all resources to 0; set target to delta
        money: 0,
        food: 0,
        coal: 0,
        oil: 0,
        uranium: 0,
        lead: 0,
        iron: 0,
        bauxite: 0,
        gasoline: 0,
        munitions: 0,
        steel: 0,
        aluminum: 0,
        [resource]: delta,
      } as any,
    });

    // Audit trail in SafeTxn (schema assumed present per your project notes)
    await tx.safeTxn.create({
      data: {
        allianceId,
        memberId,
        resource,
        amount: delta, // signed
        type: "MANUAL_ADJUST",
        actorDiscordId,
        reason: reason ?? null,
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
    sub
      .setName("add")
      .setDescription("Add resources to a member's safekeeping")
      .addUserOption((o) =>
        o
          .setName("member")
          .setDescription("Discord user to adjust (preferred)")
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("nation_id")
          .setDescription("Alternative: target by nation ID")
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("resource")
          .setDescription("Resource to add")
          .setRequired(true)
          .addChoices(
            ...RESOURCE_KEYS.map((k) => ({ name: k, value: k }))
          )
      )
      .addNumberOption((o) =>
        o
          .setName("amount")
          .setDescription("Amount to add (positive number)")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("reason")
          .setDescription("Optional audit note")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("subtract")
      .setDescription("Subtract resources from a member's safekeeping")
      .addUserOption((o) =>
        o
          .setName("member")
          .setDescription("Discord user to adjust (preferred)")
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("nation_id")
          .setDescription("Alternative: target by nation ID")
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("resource")
          .setDescription("Resource to subtract")
          .setRequired(true)
          .addChoices(
            ...RESOURCE_KEYS.map((k) => ({ name: k, value: k }))
          )
      )
      .addNumberOption((o) =>
        o
          .setName("amount")
          .setDescription("Amount to subtract (positive number)")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("reason")
          .setDescription("Optional audit note")
          .setRequired(false)
      )
  )
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const guild = i.guild;
  const memberInvoker = guild ? await guild.members.fetch(i.user.id).catch(() => null) : null;

  if (!hasBankerRoleOrAdmin(memberInvoker)) {
    return i.editReply("You must have the **Banker** role (or be an Admin) to use this command.");
  }

  const sub = i.options.getSubcommand(true);
  const targetUser = i.options.getUser("member");
  const nationId = i.options.getInteger("nation_id");
  const resource = i.options.getString("resource", true) as ResourceKey;

  if (!RESOURCE_KEYS.includes(resource)) {
    return i.editReply(`Resource must be one of: ${RESOURCE_KEYS.join(", ")}`);
  }

  const rawAmount = i.options.getNumber("amount", true);
  if (rawAmount <= 0) {
    return i.editReply("Amount must be a positive number.");
  }
  const delta = sub === "subtract" ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  const reason = i.options.getString("reason") ?? null;

  // Resolve target Member + Alliance
  const { allianceId, member } = await resolveAllianceAndMember({
    guildId: guild?.id ?? "",
    discordUserId: targetUser?.id ?? null,
    nationId: nationId ?? null,
  });

  if (!member || !allianceId) {
    return i.editReply(
      "Could not resolve the target member and alliance. Ensure the user (or nation ID) is linked in the bot database."
    );
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

  const embed = new EmbedBuilder()
    .setTitle("Safekeeping Adjusted")
    .setDescription(
      `${delta >= 0 ? "Added" : "Subtracted"} **${Math.abs(delta)} ${resource}** for <@${member.discordUserId}>`
    )
    .addFields(
      { name: "Alliance ID", value: String(allianceId), inline: true },
      { name: "Member ID", value: String(member.id), inline: true },
      { name: "Resource", value: resource, inline: true },
      { name: "Delta", value: String(delta), inline: true },
      { name: "New Balance", value: String(newValue), inline: true },
      reason ? { name: "Reason", value: reason, inline: false } : undefined as any
    )
    .setTimestamp();

  return i.editReply({ embeds: [embed] });
}

export default { data, execute };
