// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import {
  queryAllianceBankrecs,
  BankrecFilter,
} from "../lib/pnw_bank_ingest";
import { addToTreasury } from "../utils/treasury";

type BankrecRow = {
  id: number | string;
  date: string;
  note?: string | null;
  sender_type: number | string;
  sender_id: number | string;
  receiver_type: number | string;
  receiver_id: number | string;
  money?: number;
  food?: number;
  coal?: number;
  oil?: number;
  uranium?: number;
  lead?: number;
  iron?: number;
  bauxite?: number;
  gasoline?: number;
  munitions?: number;
  steel?: number;
  aluminum?: number;
};

const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron","bauxite",
  "gasoline","munitions","steel","aluminum",
] as const;

function toNum(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Apply recent tax records to the alliance Treasury (totals resources)")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("How many rows to pull (1-200)").setMinValue(1).setMaxValue(200)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = Math.min(200, Math.max(1, interaction.options.getInteger("limit") ?? 50));

  await interaction.deferReply({ ephemeral: true });

  try {
    // Pull latest taxrecs
    const rows = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX);
    const list = (rows ?? []) as BankrecRow[];

    if (!list.length) {
      await interaction.editReply(`No tax records found for alliance ${allianceId}.`);
      return;
    }

    // Sum all resources from these rows
    const delta: Record<(typeof RES_KEYS)[number], number> = {
      money:0,food:0,coal:0,oil:0,uranium:0,lead:0,iron:0,bauxite:0,
      gasoline:0,munitions:0,steel:0,aluminum:0,
    };
    for (const r of list) {
      for (const k of RES_KEYS) delta[k] += toNum((r as any)[k]);
    }

    // Credit Treasury once with the totals
    await addToTreasury(allianceId, delta);

    // Build a compact summary
    const shown = RES_KEYS
      .filter(k => delta[k] && Math.abs(delta[k]) > 0)
      .map(k => `**${k}**: ${Math.round(delta[k]).toLocaleString()}`)
      .join(" · ") || "— all zero —";

    const emb = new EmbedBuilder()
      .setTitle(`✅ Tax applied to Treasury`)
      .setDescription(`Alliance **${allianceId}** — applied **${list.length}** tax rows.`)
      .addFields({ name: "Totals credited", value: shown })
      .setColor(Colors.Green);

    await interaction.editReply({ embeds: [emb] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
