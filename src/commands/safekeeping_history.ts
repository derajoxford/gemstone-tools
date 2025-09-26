import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  GuildMember,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function hasBankerOrAdmin(m: GuildMember | null) {
  if (!m) return false;
  if (m.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return m.roles.cache.some((r) => r.name.toLowerCase() === "banker");
}

export const data = new SlashCommandBuilder()
  .setName("safekeeping_history")
  .setDescription("Show recent safekeeping ledger entries (SafeTxn).")
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("How many entries (max 25, default 10)")
      .setMinValue(1)
      .setMaxValue(25)
      .setRequired(false)
  )
  .addUserOption((o) =>
    o.setName("member").setDescription("Target user (omit to view your own)").setRequired(false)
  )
  .addIntegerOption((o) =>
    o.setName("nation_id").setDescription("Alternative: target by nation ID").setRequired(false)
  )
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  try {
    await i.deferReply({ ephemeral: true });

    const guild = i.guild;
    const invoker = guild ? await guild.members.fetch(i.user.id).catch(() => null) : null;

    const limit = Math.min(25, Math.max(1, i.options.getInteger("limit") ?? 10));
    const targetUser = i.options.getUser("member");
    const nationId = i.options.getInteger("nation_id");

    // Resolve target (defaults to invoker)
    const me = await prisma.member.findFirst({
      where: { discordId: i.user.id },
      orderBy: { id: "desc" },
    });
    const target = targetUser
      ? await prisma.member.findFirst({
          where: { discordId: targetUser.id },
          orderBy: { id: "desc" },
        })
      : nationId
      ? await prisma.member.findFirst({
          where: { nationId },
          orderBy: { id: "desc" },
        })
      : me;

    if (!target) {
      return i.editReply("Could not resolve the target member. Link your account or specify a valid member.");
    }

    const viewingSelf = target.discordId === i.user.id;
    if (!viewingSelf && !hasBankerOrAdmin(invoker)) {
      return i.editReply("You need the **Banker** role (or be an Admin) to view other members’ history.");
    }

    // If SafeTxn model is absent, fail gracefully
    const anyPrisma = prisma as any;
    if (!anyPrisma.safeTxn?.findMany) {
      return i.editReply(
        "Safekeeping history isn’t enabled on this schema (no `SafeTxn` table). We can add it later without affecting current features."
      );
    }

    const txns = await anyPrisma.safeTxn.findMany({
      where: { memberId: target.id },
      orderBy: { id: "desc" },
      take: limit,
    });
    if (!txns || txns.length === 0) {
      return i.editReply("No ledger entries found for this member.");
    }

    const totals = new Map<string, number>();
    for (const t of txns) totals.set(t.resource, (totals.get(t.resource) ?? 0) + Number(t.amount));

    const lines = txns.map((t: any) => {
      const sign = Number(t.amount) >= 0 ? "➕" : "➖";
      const when = new Date(t.createdAt ?? Date.now()).toISOString().replace("T", " ").slice(0, 19);
      const who = t.actorDiscordId ? `<@${t.actorDiscordId}>` : "system";
      return `${when} • ${sign} **${Math.abs(Number(t.amount))} ${t.resource}** by ${who}${
        t.reason ? ` — _${t.reason}_` : ""
      }`;
    });

    const embed = new EmbedBuilder()
      .setTitle("Safekeeping History")
      .setDescription(lines.join("\n"))
      .addFields(
        ...[...totals.entries()].map(([res, amt]) => ({
          name: res,
          value: String(amt),
          inline: true,
        }))
      )
      .setFooter({ text: `Member ID ${target.id} • Showing ${txns.length}` })
      .setTimestamp();

    return i.editReply({ embeds: [embed] });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
    try {
      if (i.deferred || i.replied) {
        await i.editReply(`❌ Error: ${msg}`);
      } else {
        await i.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
      }
    } catch {}
    console.error("safekeeping_history error:", err);
  }
}

export default { data, execute };
