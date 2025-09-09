// src/commands/pnw_tax_ids.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  bold,
  inlineCode,
} from "discord.js";
import {
  getAllowedTaxIds,
  setAllowedTaxIds,
  addAllowedTaxId,
  removeAllowedTaxId,
} from "../utils/pnw_tax_ids";
import { getAllianceReadKey } from "../integrations/pnw/store";
import { pnwQuery } from "../integrations/pnw/query";

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_ids")
  .setDescription("Manage which PnW tax bracket IDs are included in tax processing.")
  .addStringOption(o =>
    o.setName("action")
      .setDescription("list | set | add | remove | clear | sniff")
      .setRequired(true)
      .addChoices(
        { name: "list", value: "list" },
        { name: "set", value: "set" },
        { name: "add", value: "add" },
        { name: "remove", value: "remove" },
        { name: "clear", value: "clear" },
        { name: "sniff (show recent tax_id values)", value: "sniff" },
      )
  )
  .addIntegerOption(o =>
    o.setName("alliance_id")
      .setDescription("Alliance ID")
      .setRequired(true)
  )
  .addStringOption(o =>
    o.setName("ids")
      .setDescription("Comma/space-separated tax IDs for 'set'")
      .setRequired(false)
  )
  .addIntegerOption(o =>
    o.setName("tax_id")
      .setDescription("Single tax ID for add/remove")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const action = interaction.options.getString("action", true);
  const allianceId = interaction.options.getInteger("alliance_id", true);

  await interaction.deferReply({ ephemeral: true });

  try {
    if (action === "list") {
      const ids = await getAllowedTaxIds(allianceId);
      await interaction.editReply(
        `${bold("Alliance")}: ${allianceId}\n${bold("Allowed tax IDs")}: ${ids.length ? ids.join(", ") : "(none — all tax rows allowed)"}`
      );
      return;
    }

    if (action === "clear") {
      await setAllowedTaxIds(allianceId, []);
      await interaction.editReply(
        `${bold("Alliance")}: ${allianceId}\nCleared allowed tax IDs. (All tax rows will be included.)`
      );
      return;
    }

    if (action === "set") {
      const raw = interaction.options.getString("ids", true);
      const ids = raw.split(/[,\s]+/).filter(Boolean).map(n => Number(n));
      await setAllowedTaxIds(allianceId, ids);
      const list = await getAllowedTaxIds(allianceId);
      await interaction.editReply(
        `${bold("Alliance")}: ${allianceId}\nSet ${bold("allowed tax IDs")}: ${list.join(", ")}`
      );
      return;
    }

    if (action === "add") {
      const id = interaction.options.getInteger("tax_id", true);
      await addAllowedTaxId(allianceId, id);
      const list = await getAllowedTaxIds(allianceId);
      await interaction.editReply(
        `${bold("Alliance")}: ${allianceId}\nAdded ${inlineCode(String(id))}. Now: ${list.join(", ")}`
      );
      return;
    }

    if (action === "remove") {
      const id = interaction.options.getInteger("tax_id", true);
      await removeAllowedTaxId(allianceId, id);
      const list = await getAllowedTaxIds(allianceId);
      await interaction.editReply(
        `${bold("Alliance")}: ${allianceId}\nRemoved ${inlineCode(String(id))}. Now: ${list.length ? list.join(", ") : "(none)"}`
      );
      return;
    }

    if (action === "sniff") {
      // Show distinct tax_id values seen recently (helps choose)
      const apiKey = await getAllianceReadKey(allianceId);
      const query = `
        query SniffTaxIds($ids: [Int], $limit: Int) {
          alliances(id: $ids) {
            data {
              id
              bankrecs(limit: $limit) {
                id
                stype
                rtype
                tax_id
              }
            }
          }
        }
      ` as const;
      const data = await pnwQuery<any>(apiKey, query, { ids: [allianceId], limit: 250 });
      const recs: any[] = data?.alliances?.data?.[0]?.bankrecs ?? [];
      const taxRows = recs.filter(r =>
        r?.tax_id != null &&
        String(r?.rtype ?? "").toLowerCase() === "alliance" &&
        String(r?.stype ?? "").toLowerCase() === "nation"
      );
      const distinct = Array.from(new Set(taxRows.map(r => Number(r.tax_id)).filter(Number.isFinite))).sort((a, b) => a - b);
      await interaction.editReply(
        `${bold("Alliance")}: ${allianceId}\n${bold("Distinct recent tax_id values")}: ${distinct.length ? distinct.join(", ") : "(none found in recent window)"}`
      );
      return;
    }

    await interaction.editReply("Unknown action.");
  } catch (err: any) {
    await interaction.editReply(`Error: ${err?.message ?? String(err)}`);
  }
}

export default { data, execute };
