// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import {
  queryAllianceBankrecs,
  BankrecFilter,
} from "../lib/pnw_bank_ingest";

// Helper to coerce the filter safely
function parseFilter(raw?: string | null): BankrecFilter {
  const v = (raw || "").toLowerCase();
  if (v === "tax") return BankrecFilter.TAX;
  return BankrecFilter.ALL;
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Show recent alliance bank/tax records (PnW)")
  .addIntegerOption((o) =>
    o
      .setName("alliance_id")
      .setDescription("PnW alliance ID (e.g. 14258)")
      .setRequired(true)
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
    o
      .setName("limit")
      .setDescription("How many rows (default 10, max 50)")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitRaw = interaction.options.getInteger("limit", false) ?? 10;
  const limit = Math.max(1, Math.min(50, limitRaw));
  const filter = parseFilter(interaction.options.getString("filter", false));

  await interaction.deferReply({ ephemeral: false });

  try {
    // IMPORTANT: use positional args (number, limit, filter) to avoid the undefined-object bug
    const rows = await queryAllianceBankrecs(allianceId, limit, filter);

    if (!rows || rows.length === 0) {
      await interaction.editReply(
        `Alliance **${allianceId}** • filter=\`${filter}\` • limit=${limit}\n\n_No records found._`
      );
      return;
    }

    const lines = rows.map((x) => {
      const sT = Number(x.sender_type);
      const rT = Number(x.receiver_type);
      const sId = String(x.sender_id);
      const rId = String(x.receiver_id);
      const note = x.note ?? "";
      const ts = new Date(x.date).toISOString().replace("T", " ").replace(".000Z", "Z");
      return `• **${x.id}** — ${ts} — S:${sT}/${sId} → R:${rT}/${rId} — _${note}_`;
    });

    const title =
      filter === BankrecFilter.TAX
        ? `Alliance ${allianceId} • taxrecs • limit=${limit}`
        : `Alliance ${allianceId} • bankrecs • limit=${limit}`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(lines.join("\n").slice(0, 4000))
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    const msg =
      err?.message ??
      (typeof err === "string" ? err : "Unknown error");
    await interaction.editReply(`❌ Error: ${msg}`);
  }
}
