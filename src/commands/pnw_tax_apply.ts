// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { queryAllianceBankrecs, BankrecFilter } from "../lib/pnw_bank_ingest";
import { addToTreasury, sumRowsToDelta } from "../utils/treasury";

const KEYS: Array<keyof ReturnType<typeof sumRowsToDelta>> = [
  "money","food","coal","oil","uranium","lead","iron","bauxite",
  "gasoline","munitions","steel","aluminum",
];

function prettyDelta(delta: Record<string, number>) {
  const lines: string[] = [];
  for (const k of KEYS) {
    const v = Number(delta[k] ?? 0);
    if (v) lines.push(`• **${k}**: ${v.toLocaleString()}`);
  }
  return lines.join("\n") || "_No resources in this batch._";
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Sum recent tax records and credit to the alliance treasury")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("How many recent tax rows to apply (1-200)").setMinValue(1).setMaxValue(200)
  )
  .addBooleanOption(o =>
    o.setName("dry_run").setDescription("Preview only (no DB write)").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitRaw = interaction.options.getInteger("limit", false) ?? 25;
  const limit = Math.min(200, Math.max(1, limitRaw));
  const dryRun = interaction.options.getBoolean("dry_run", false) ?? false;

  await interaction.deferReply({ ephemeral: true });

  try {
    // 1) Fetch recent tax rows
    const rows = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX);

    // 2) Sum into a delta
    const delta = sumRowsToDelta(rows as any[]);

    // 3) Prepare embed
    const title = `Alliance ${allianceId} • taxrecs • apply ${rows.length}/${limit}${dryRun ? " • DRY-RUN" : ""}`;
    const emb = new EmbedBuilder()
      .setTitle(title)
      .setDescription(prettyDelta(delta as any))
      .setColor(dryRun ? Colors.Yellow : Colors.Blurple)
      .setFooter({ text: rows.length ? `Newest taxrec id: ${rows[0].id}` : "No rows" })
      .setTimestamp(new Date());

    // 4) Apply if not dry-run
    if (!dryRun) {
      await addToTreasury(allianceId, delta as any);
    }

    await interaction.editReply({ embeds: [emb] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
