// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  time,
  TimestampStyles,
} from "discord.js";
import { queryAllianceBankrecs, BankrecFilter } from "../lib/pnw_bank_ingest";

function parseFilter(raw?: string | null): BankrecFilter {
  const v = (raw || "").toLowerCase();
  return v === "tax" ? BankrecFilter.TAX : BankrecFilter.ALL;
}

function clampLimit(n: number) {
  return Math.min(50, Math.max(1, n));
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
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
  const limitRaw = interaction.options.getInteger("limit", false) ?? 10;
  const limit = clampLimit(limitRaw);
  const filter = parseFilter(interaction.options.getString("filter", false));

  await interaction.deferReply();

  try {
    // NOTE: our lib accepts (allianceId, limit, filter)
    const rows = await queryAllianceBankrecs(allianceId, limit, filter);

    const title =
      filter === BankrecFilter.TAX
        ? `Alliance ${allianceId} • taxrecs • limit=${limit}`
        : `Alliance ${allianceId} • bankrecs • limit=${limit}`;

    if (!rows || rows.length === 0) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle(title).setDescription("_No records found._")],
      });
      return;
    }

    const lines = rows.map((x) => {
      const when = fmtWhen(x.date);
      const s = `S:${x.sender_type}/${x.sender_id}`;
      const r = `R:${x.receiver_type}/${x.receiver_id}`;
      // Strip HTML tags if any; entities like &bull; will just display literally (fine).
      const note = (x.note || "").replace(/<[^>]+>/g, "").trim();
      return `**${x.id}** • ${when}\n\`${s} → ${r}\`\n_${note || "—"}_`;
    });

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join("\n\n").slice(0, 4000))
      .setFooter({ text: "PnW API" })
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
