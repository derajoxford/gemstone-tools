// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { ingestAllianceBankrecs, queryAllianceBankrecs, type PeekFilter } from "../lib/pnw_bank_ingest.js";

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Preview cached alliance bank records (uses root bankrecs + local cache).")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addStringOption(o =>
    o
      .setName("filter")
      .setDescription("Filter rows")
      .addChoices(
        { name: "all", value: "all" },
        { name: "tax", value: "tax" },
        { name: "nontax", value: "nontax" },
      )
      .setRequired(false),
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("How many rows (default 8, max 100)").setRequired(false),
  )
  .addStringOption(o =>
    o.setName("after_id").setDescription("Start after this bankrec id").setRequired(false),
  )
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const allianceId = i.options.getInteger("alliance_id", true);
  const filter = (i.options.getString("filter") || "all") as PeekFilter;
  const limit = i.options.getInteger("limit") ?? 8;
  const afterId = i.options.getString("after_id") || undefined;

  // Short prefetch/ingest (bounded pages) so cache stays fresh but fast
  try {
    await ingestAllianceBankrecs(allianceId, { maxPages: 8, pageSize: 50 });
  } catch (err: any) {
    // If alliances() path 500s we still want to try cache; this ingestor only uses root bankrecs
    // But handle generic HTTP failures cleanly:
    if (String(err?.message || err).includes("HTTP 500")) {
      await i.editReply(`❌ PnW GraphQL returned 500 and ingest could not complete; showing cached data only.`);
    } else if (String(err?.message || err).includes("apiKey")) {
      await i.editReply(`❌ ${String(err?.message || err)}`);
      return;
    }
    // else: continue to show whatever cache has
  }

  const rows = await queryAllianceBankrecs(allianceId, { filter, limit, afterId });

  if (!rows.length) {
    await i.editReply(`Alliance ${allianceId} • after_id=${afterId ?? "-"} • filter=${filter} • limit=${limit}\n\nNo bank records found.`);
    return;
  }

  const header = `Alliance ${allianceId} • after_id=${afterId ?? "-"} • filter=${filter} • limit=${limit}`;
  const lines = rows.map(r => {
    const tag = r.is_tax_guess ? "TAX" : "ROW";
    const note = (r.note || "").replace(/&bull;/g, "•").replace(/\s+/g, " ");
    return `${r.id} • ${r.date.toISOString()} • ${tag} • ${note.substring(0, 120)}`;
  });

  await i.editReply([header, "", ...lines].join("\n"));
}
