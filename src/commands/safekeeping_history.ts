import { COLORS, RESOURCE_META, fmtAmount, resourceLabel, discordRelative } from "../utils/pretty.js";

// ... after you fetched `txns` and `target`

const lines = txns.map((t) => {
  const meta = RESOURCE_META[t.resource as keyof typeof RESOURCE_META] ?? { emoji: "📦" };
  const sign = Number(t.amount) >= 0 ? "➕" : "➖";
  const when = discordRelative((t as any).createdAt ?? Date.now());
  const who = t.actorDiscordId ? `<@${t.actorDiscordId}>` : "system";
  return `${meta.emoji} ${sign} **${fmtAmount(Math.abs(Number(t.amount)))} ${t.resource}** — ${who} • ${when}${t.reason ? `\n> _${t.reason}_` : ""}`;
});

const totals = new Map<string, number>();
for (const t of txns) totals.set(t.resource, (totals.get(t.resource) ?? 0) + Number(t.amount));

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

return i.editReply({ embeds: [embed] });
