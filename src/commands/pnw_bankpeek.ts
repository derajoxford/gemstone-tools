// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  time,
  TimestampStyles,
  Colors,
} from "discord.js";
import {
  queryAllianceBankrecs,
  BankrecFilter,
} from "../lib/pnw_bank_ingest";

function parseFilter(raw?: string | null): BankrecFilter {
  const v = (raw || "").toLowerCase();
  return v === "tax" ? BankrecFilter.TAX : BankrecFilter.ALL;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  // e.g. "Sep 23, 9:00 PM • an hour ago"
  return `${time(d, TimestampStyles.ShortDateTime)} • ${time(d, TimestampStyles.RelativeTime)}`;
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Show recent alliance bank/tax records (PnW)")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("filter")
      .setDescription("Which records to show")
      .addChoices(
        { name: "all (bankrecs)", value: "all" },
        { name: "tax (taxrecs)", value: "tax" },
      )
  )
  .addIntegerOption((o) =>
    o.setName("limit").setDescription("How many rows (1-50)").setMinValue(1).setMaxValue(50)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = interaction.options.getInteger("limit", false) ?? 10;
  const filter = parseFilter(interaction.options.getString("filter", false));

  await interaction.deferReply();

  try {
    const rows = await queryAllianceBankrecs(
      allianceId,
      Math.min(50, Math.max(1, limit)),
      filter
    );

    const title =
      filter === BankrecFilter.TAX
        ? `Alliance ${allianceId} • Tax Records`
        : `Alliance ${allianceId} • Bank Records`;

    if (!rows || rows.length === 0) {
      const empty = new EmbedBuilder()
        .setTitle(title)
        .setDescription("_No records found._")
        .setColor(Colors.Greyple)
        .setFooter({ text: "PnW API" })
        .setTimestamp(new Date());
      await interaction.editReply({ embeds: [empty] });
      return;
    }

    // Build fields: one field per record (<=25; our limit is 50, but we clamp later)
    const fields = rows.slice(0, 25).map((x) => {
      const when = fmtWhen(x.date);
      const s = `S:${x.sender_type}/${x.sender_id}`;
      const r = `R:${x.receiver_type}/${x.receiver_id}`;
      const note = x.note?.replaceAll(/<[^>]+>/g, "")?.trim() || "—";
      return {
        name: `#${x.id} — ${when}`,
        value: `\`${s} → ${r}\`\n*${note}*`,
      };
    });

    const emb = new EmbedBuilder()
      .setAuthor({ name: "Gemstone Tools • PnW", iconURL: "https://cdn.discordapp.com/icons/1407069252938109060/a_8fbd1f2.png?size=64" })
      .setTitle(title)
      .addFields(...fields)
      .setColor(filter === BankrecFilter.TAX ? Colors.Gold : Colors.Blurple)
      .setFooter({
        text: `Showing ${Math.min(rows.length, 25)} of ${rows.length} • limit=${limit}`,
      })
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [emb] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
