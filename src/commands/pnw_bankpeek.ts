// src/commands/pnw_bankpeek.ts
import type { ChatInputCommandInteraction } from "discord.js";
import {
  SlashCommandBuilder,
} from "discord.js";
import {
  fetchAllianceBankrecs,
  applyPeekFilter,
  type PeekFilter,
} from "../lib/pnw_bank_ingest";
import { getAllianceApiKey } from "../utils/secrets"; // tiny helper you already have (or env fallback)

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Peek recent alliance bank records")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .addStringOption(o =>
    o.setName("filter")
     .setDescription("all | tax | nontax")
     .addChoices(
       { name: "all", value: "all" },
       { name: "tax", value: "tax" },
       { name: "nontax", value: "nontax" },
     )
     .setRequired(false))
  .addIntegerOption(o =>
    o.setName("limit").setDescription("Rows (<=100)").setRequired(false))
  .addIntegerOption(o =>
    o.setName("after_id").setDescription("Only ids > after_id").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const allianceId = interaction.options.getInteger("alliance_id", true);
  const filter = (interaction.options.getString("filter") ?? "all") as PeekFilter;
  const limit = Math.max(1, Math.min(100, interaction.options.getInteger("limit") ?? 25));
  const afterId = interaction.options.getInteger("after_id") ?? null;

  // Pull API key for this alliance (fallback to env if you do that)
  const apiKey = await getAllianceApiKey(allianceId);
  if (!apiKey) {
    await interaction.editReply(`Alliance ${allianceId} • missing API key`);
    return;
  }

  try {
    const rows = await fetchAllianceBankrecs({
      apiKey,
      allianceId,
      limit,
      minId: afterId,
    });

    const filtered = applyPeekFilter(rows, filter);
    const head = filtered.slice(0, limit);

    if (head.length === 0) {
      await interaction.editReply(`Alliance ${allianceId} • after_id=${afterId ?? "—"} • filter=${filter} • limit=${limit}\n\nNo bank records found.`);
      return;
    }

    const lines = head.map(r => {
      const when = new Date(r.date).toISOString().replace("T", " ").replace(".000Z", "Z");
      const note = (r.note ?? "").replaceAll("\n", " ").slice(0, 120);
      return `• #${r.id} — ${when} — s(${r.sender_type}:${r.sender_id}) → r(${r.receiver_type}:${r.receiver_id}) — ${note}`;
    });

    await interaction.editReply(
      [
        `Alliance ${allianceId} • after_id=${afterId ?? "—"} • filter=${filter} • limit=${limit}`,
        "",
        ...lines,
      ].join("\n")
    );
  } catch (err: any) {
    await interaction.editReply(`Alliance ${allianceId} • error: ${err?.message ?? String(err)}`);
  }
}
