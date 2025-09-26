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

// Safer resolvers (avoid empty OR and invalid fields)
async function findMemberByDiscordId(discordId: string | null) {
  if (!discordId) return null;
  return prisma.member.findFirst({
    where: { discordId },
    orderBy: { id: "desc" },
  });
}
async function findMemberByNationId(nationId: number | null) {
  if (nationId == null) return null;
  return prisma.member.findFirst({
    where: { nationId },
    orderBy: { id: "desc" },
  });
}

export const data = new SlashCommandBuilder()
  .setName("safekeeping_adjust")
  .setDescription("Bankers: add or subtract resources in a member's safekeeping.")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add resources")
      // REQUIRED FIRST (Discord requirement)
      .addStringOption((o) =>
        o
          .setName("resource")
          .setDescription("Resource")
          .setRequired(true)
          .addChoices(...RESOURCE_KEYS.map((k) => ({ name: k, value: k })))
      )
      .addNumberOption((o) =>
        o.setName("amount").setDescription("Amount (positive)").setRequired(true)
      )
      // OPTIONAL AFTER
      .addUserOption((o) =>
        o.setName("member").setDescription("Discord user").setRequired(false)
      )
      .addIntegerOption((o) =>
        o.setName("nation_id").setDescription("Target by nation ID").setRequired(false)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Audit note").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("subtract")
      .setDescription("Subtract resources")
      // REQUIRED FIRST
      .addStringOption((o) =>
        o
          .setName("resource")
          .setDescription("Resource")
          .setRequired(true)
          .addChoices(...RESOURCE_KEYS.map((k) => ({ name: k, value: k })))
      )
      .addNumberOption((o) =>
        o.setName("amount").setDescription("Amount (positive)").setRequired(true)
      )
      // OPTIONAL AFTER
      .addUserOption((o) =>
        o.setName("member").setDescription("Discord user").setRequired(false)
      )
      .addIntegerOption((o) =>
        o.setName("nation_id").setDescription("Target by nation ID").setRequired(false)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("Audit note").setRequired(false)
      )
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

    // Resolve target member: prefer explicit targetUser, then nation_id, else invoker
    const member =
      (await findMemberByDiscordId(targetUser?.id ?? null)) ??
      (await findMemberByNationId(nationId ?? null)) ??
      (await findMemberByDiscordId(i.user.id));

    if (!member) {
      return i.editReply(
        "Could not resolve the target member. Make sure the user is linked in the DB, or specify `member` / `nation_id`."
      );
    }

    // ---- Safekeeping update without upsert (works regardless of unique constraints) ----
    const updated = await prisma.$transaction(async (tx) => {
      // Unique on memberId, so we can find by memberId directly
      const existing = await tx.safekeeping.findUnique({
        where: { memberId: member.id },
      });

      let safeRow;
      if (existing) {
        safeRow = await tx.safekeeping.update({
          where: { id: existing.id },
          data: { [resource]: { increment: delta } as any },
        });
      } else {
        // create with zeros, then apply delta to target resource
        const base: any = {
          memberId: member.id,
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
        };
        base[resource] = delta;
        safeRow = await tx.safekeeping.create({ data: base });
      }

      // Best-effort audit (matches SafeTxn model)
      const anyTx = tx as any;
      if (anyTx.safeTxn?.create) {
        await anyTx.safeTxn
          .create({
            data: {
              memberId: member.id,
              resource,
              amount: delta,
              type: "MANUAL_ADJUST",
              actorDiscordId: i.user.id,
              reason: reason ?? null,
            },
          })
          .catch(() => {});
      }

      return safeRow;
    });

    const newValue = Number((updated as any)[resource] ?? 0);

    const embed = new EmbedBuilder()
      .setTitle("Safekeeping Adjusted")
      .setDescription(
        `${delta >= 0 ? "Added" : "Subtracted"} **${Math.abs(delta)} ${resource}** for <@${member.discordId}>`
      )
      .addFields(
        { name: "Member ID", value: String(member.id), inline: true },
        { name: "Delta", value: String(delta), inline: true },
        { name: "New Balance", value: String(newValue), inline: true },
        reason ? ({ name: "Reason", value: reason, inline: false } as any) : undefined!
      )
      .setTimestamp();

    await i.editReply({ embeds: [embed] });

    // Optional: post to manual log channel if configured (in-memory setting)
    if (guild) {
      const chId = await getGuildSetting(guild.id, "manual_adjust_log_channel_id");
      if (chId) {
        const ch = guild.channels.cache.get(chId) as TextChannel | undefined;
        if (ch?.isTextBased()) {
          const log = new EmbedBuilder()
            .setTitle("Manual Safekeeping Adjustment")
            .setDescription(
              `<@${i.user.id}> ${delta >= 0 ? "added" : "subtracted"} **${Math.abs(delta)} ${resource}** for <@${member.discordId}>`
            )
            .addFields(
              { name: "Member ID", value: String(member.id), inline: true },
              { name: "Delta", value: String(delta), inline: true },
              { name: "New Balance", value: String(newValue), inline: true },
              reason ? ({ name: "Reason", value: reason, inline: false } as any) : undefined!
            )
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
