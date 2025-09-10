// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { getAllianceReadKey } from "../integrations/pnw/store";
import { pnwQuery } from "../integrations/pnw/query";

async function replyError(i: ChatInputCommandInteraction, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await i.editReply(`❌ ${msg}`);
  console.error("[/pnw_bankpeek] error:", err);
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: show the latest alliance bank records (raw fields)")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Records to fetch (default 20, max 100)")
      .setMinValue(1)
      .setMaxValue(100),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const limit = interaction.options.getInteger("limit") ?? 20;

    const apiKey = await getAllianceReadKey(allianceId);

    // Keep this schema super-simple to avoid arg compatibility issues.
    const query = /* GraphQL */ `
      query AllianceBankrecs($ids: [Int], $limit: Int!) {
        alliances(id: $ids) {
          data {
            id
            bankrecs(limit: $limit) {
              id
              date
              note
              stype
              rtype
              money
              food
              munitions
              gasoline
              steel
              aluminum
              oil
              uranium
              bauxite
              coal
              iron
              lead
              tax_id
            }
          }
        }
      }
    `;

    const vars: any = { ids: [allianceId], limit };
    const data: any = await pnwQuery(apiKey, query, vars);

    const alliances = Array.isArray(data?.alliances?.data)
      ? data.alliances.data
      : Array.isArray(data?.alliances)
      ? data.alliances
      : [];

    const recs: any[] = alliances?.[0]?.bankrecs ?? [];

    if (!recs.length) {
      await interaction.editReply(
        `Alliance **${allianceId}** — no bank records returned (limit ${limit}).`,
      );
      return;
    }

    // Show the first N (already limited in the query). Trim long notes.
    const lines = recs.map((r) => {
      const id = r?.id ?? "?";
      const date = r?.date ?? "?";
      const st = r?.stype ?? "?";
      const rt = r?.rtype ?? "?";
      const tid = r?.tax_id ?? "-";
      const money = r?.money ?? 0;
      let note = String(r?.note ?? "");
      if (note.length > 90) note = note.slice(0, 87) + "…";
      return `• #${id} | ${date} | ${st}→${rt} | $${money} | tax_id:${tid} | ${note}`;
    });

    await interaction.editReply(
      [
        `Alliance **${allianceId}** — latest ${recs.length} bank records:`,
        "```",
        ...lines,
        "```",
        "If a line contains your tax rows, we’ll mirror that exact pattern in the catcher.",
      ].join("\n"),
    );
  } catch (err) {
    await replyError(interaction, err);
  }
}
