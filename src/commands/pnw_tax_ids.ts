// src/commands/pnw_tax_ids.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { getAllianceReadKey } from "../integrations/pnw/store";
import { pnwQuery } from "../integrations/pnw/query";
import {
  getAllowedTaxIds,
  setAllowedTaxIds,
  clearAllowedTaxId as _clearOne, // optional helper, not used here
} from "../utils/pnw_tax_ids";

// ---- small utils ----
function parseIdList(s: string): number[] {
  return s
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => Number(t))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

function fmtList(nums: number[]) {
  return nums.length ? nums.join(", ") : "—";
}

async function replyError(interaction: ChatInputCommandInteraction, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await interaction.editReply(`❌ ${msg}`);
  console.error("[/pnw_tax_ids] error:", err);
}

// ---- sniff helper (with schema-safe query + tiny debug dump) ----
async function sniffTaxIdsUsingStoredKey(
  allianceId: number,
  lookbackLimit = 250,
): Promise<{
  counts: { id: number; count: number }[];
  sample: string[];
  total: number;
}> {
  const apiKey = await getAllianceReadKey(allianceId);

  const query = /* GraphQL */ `
    query SniffTaxIds($ids: [Int!]!, $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            tax_id
            stype
            rtype
            note
          }
        }
      }
    }
  `;
  const vars = { ids: [allianceId], limit: lookbackLimit };
  const data: any = await pnwQuery(apiKey, query, vars);

  const recs: any[] = data?.alliances?.data?.[0]?.bankrecs ?? [];
  const counts = new Map<number, number>();
  for (const r of recs) {
    const tid = Number(r?.tax_id ?? 0);
    if (!tid) continue;
    counts.set(tid, (counts.get(tid) ?? 0) + 1);
  }

  // build a short debug sample so we can see what's actually coming back
  const sample: string[] = [];
  for (const r of recs.slice(0, 10)) {
    const line =
      `• ${r.id} | tax_id=${r.tax_id ?? "—"} | stype=${r.stype ?? "—"} | rtype=${r.rtype ?? "—"} | note=${(r.note ?? "").slice(0, 60)}`;
    sample.push(line);
  }

  return {
    counts: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
    sample,
    total: recs.length,
  };
}

// ---- slash command ----
export const data = new SlashCommandBuilder()
  .setName("pnw_tax_ids")
  .setDescription("Manage which PnW tax_id values are treated as tax credits")
  .addSubcommand((s) =>
    s
      .setName("sniff")
      .setDescription("Scan recent bank records and suggest tax_id values (shows a small debug sample)")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("Bank records to scan (default 250)")
          .setMinValue(50)
          .setMaxValue(500),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("get")
      .setDescription("Show stored tax_id filter")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("set")
      .setDescription("Set stored tax_id filter")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("ids")
          .setDescription("Comma/space separated tax IDs (e.g. 12, 34 56)")
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("clear")
      .setDescription("Clear stored tax_id filter")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
      ),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const sub = interaction.options.getSubcommand(true);
    const allianceId = interaction.options.getInteger("alliance_id", true)!;

    if (sub === "sniff") {
      const limit = interaction.options.getInteger("limit") ?? 250;
      const { counts, sample, total } = await sniffTaxIdsUsingStoredKey(allianceId, limit);

      const lines: string[] = [];
      lines.push(`**Alliance:** ${allianceId}`);
      lines.push(`**Lookback:** ${limit} (returned ${total} rows)`);
      if (counts.length === 0) {
        lines.push(`No \`tax_id\` values detected.`);
      } else {
        lines.push(`**Detected \`tax_id\` values:**`);
        lines.push(...counts.map((p) => `• \`${p.id}\`  (${p.count} hits)`));
      }

      // small debug sample (up to 10)
      lines.push("");
      lines.push("**Sample (first 10 rows):**");
      lines.push(...(sample.length ? sample : ["(no rows returned)"]));

      if (counts.length > 0) {
        lines.push("");
        lines.push("You can store a filter with:");
        lines.push(`\`/pnw_tax_ids set alliance_id:${allianceId} ids:<list from above>\``);
      }

      await interaction.editReply(lines.join("\n"));
      return;
    }

    if (sub === "get") {
      const ids = await getAllowedTaxIds(allianceId);
      await interaction.editReply(
        `Stored tax_id filter for **${allianceId}**: ${fmtList(ids ?? [])}`,
      );
      return;
    }

    if (sub === "set") {
      const raw = interaction.options.getString("ids", true);
      const ids = parseIdList(raw);
      if (!ids.length) {
        await interaction.editReply("Please provide at least one integer tax_id.");
        return;
      }
      await setAllowedTaxIds(allianceId, ids);
      await interaction.editReply(
        `Saved tax_id filter for **${allianceId}**: ${fmtList(ids)}\n` +
          "Future previews/apply will only count bankrecs whose `tax_id` is in this list.",
      );
      return;
    }

    if (sub === "clear") {
      await setAllowedTaxIds(allianceId, []); // simple clear
      await interaction.editReply(`Cleared stored tax_id filter for **${allianceId}**.`);
      return;
    }

    await interaction.editReply("Unknown subcommand.");
  } catch (err) {
    await replyError(interaction, err);
  }
}
