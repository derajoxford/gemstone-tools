import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  GuildMember,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import {
  COLORS,
  RESOURCE_META,
  fmtAmount,
  resourceLabel,
  discordRelative,
} from "../utils/pretty.js";

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
    o
      .setName("member")
      .setDescription("Target user (omit to view your own)")
      .setRequired(false)
  )
  .addIntegerOption((o) =>
    o
      .setName("nation_id")
      .setDescription("Alternative: target by nation ID")
      .setRequired(false)
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

    // Resolve target member
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
      await i.editReply(
        "Could not resolve the target member. Link your account or specify a valid member."
      );
      return;
    }

    const viewingSelf = target.discordId === i.user.id;
    if (!viewingSelf && !hasBankerOrAdmin(invoker)) {
      await i.editReply(
        "You need the **Banker** role (or be an Admin) to view other members’ history."
      );
      return;
    }

    // Read transactions
    const txns = await prisma.safeTxn.findMany({
      where: { memberId: target.id },
      orderBy: { id: "desc" },
      take: limit,
    });

    if (txns.length === 0) {
      await i.editReply("No ledger entries found for this member.");
      return;
    }

    // Build pretty lines + totals
    const lines = txns.map((t) => {
      const meta = RESOURCE_META[t.resource as keyof typeof RESOURCE_META] ?? {
        emoji: "📦",
      };
      const sign = Number(t.amount) >= 0 ? "➕" : "➖";
      const when = discordRelative((t as any).createdAt ?? Date.now());
      const who = t.actorDiscordId ? `<@${t.actorDiscordId}>` : "system";
      return `${meta.emoji} ${sign} **${fmtAmount(
        Math.abs(Number(t.amount))
      )} ${t.resource}** — ${who} • ${when}${
        (t as any).reason ? `\n> _${(t as any).reason}_` : ""
      }`;
    });

    const totals = new Map<string, number>();
    for (const t of txns) {
      totals.set(t.resource, (totals.get(t.resource) ?? 0) + Number(t.amount));
    }

    const summaryFields = [...totals.entries()].map(([res, amt]) => ({
      name: resourceLabel(res as any),
      value: (amt >= 0 ? "➕ " : "➖ ") + fmtAmount(Math.abs(amt)),
      inline: true,
    }));

    const embed = new EmbedBuilder()
      .setColor(COLORS.blurple)
      .setAuthor({ name: "Safekeeping History" })
      .setDescription(lines.join("\n\n"))
      .addFields(...summaryFields)
      .setFooter({ text: `Member ID ${target.id} • Showing ${txns.length}` })
      .setTimestamp();

    await i.editReply({ embeds: [embed] });
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
    try {
      if (i.deferred || i.replied) await i.editReply(`❌ Error: ${msg}`);
      else await i.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
    } catch {}
    console.error("safekeeping_history error:", err);
  }
}

export default { data, execute };
