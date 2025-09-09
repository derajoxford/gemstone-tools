// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { addToTreasury } from "../utils/treasury";
import { getAllianceReadKey } from "../integrations/pnw/store";
import { pnwQuery } from "../integrations/pnw/query";

// ----------------- helpers -----------------
type Num = number | null | undefined;

function n(v: Num): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function buildDeltaFromInteraction(i: ChatInputCommandInteraction) {
  // all fields optional; default 0s
  return {
    money: n(i.options.getNumber("money")),
    food: n(i.options.getNumber("food")),
    munitions: n(i.options.getNumber("munitions")),
    gasoline: n(i.options.getNumber("gasoline")),
    steel: n(i.options.getNumber("steel")),
    aluminum: n(i.options.getNumber("aluminum")),
    oil: n(i.options.getNumber("oil")),
    uranium: n(i.options.getNumber("uranium")),
    bauxite: n(i.options.getNumber("bauxite")),
    coal: n(i.options.getNumber("coal")),
    iron: n(i.options.getNumber("iron")),
    lead: n(i.options.getNumber("lead")),
  };
}

function pickAllianceNode(node: any): any | null {
  // PnW can return an array or a single paginated-ish object depending on schema/version.
  if (!node) return null;
  if (Array.isArray(node)) return node[0] ?? null;
  return node;
}

/**
 * Scan recent bankrecs to count tax_id occurrences.
 * Uses schema-safe arguments: alliances(id: $id), bankrecs(limit: $limit, orderBy: "id desc").
 */
async function sniffTaxIdsUsingStoredKey(allianceId: number, lookbackLimit = 250) {
  const query = `
    query SniffTaxIds($id: Int!, $limit: Int!) {
      alliances(id: $id) {
        id
        bankrecs(limit: $limit, orderBy: "id desc") {
          id
          tax_id
        }
      }
    }
  ` as const;

  const apiKey = await getAllianceReadKey(allianceId);
  const data: any = await pnwQuery(apiKey, query, { id: allianceId, limit: lookbackLimit });

  const alliancesNode = pickAllianceNode(data?.alliances);
  const recs: any[] = alliancesNode?.bankrecs ?? [];
  const counts = new Map<number, number>();

  for (const r of recs) {
    const tid = Number(r?.tax_id ?? 0);
    if (!Number.isFinite(tid) || tid <= 0) continue;
    counts.set(tid, (counts.get(tid) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count }));
}

async function replyError(interaction: ChatInputCommandInteraction, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await interaction.editReply(`❌ ${msg}`);
  console.error("[/treasury_add] error:", err);
}

// ----------------- command definition -----------------
export const data = new SlashCommandBuilder()
  .setName("treasury_add")
  .setDescription("Manually add resources to an alliance treasury, or sniff tax_id values")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add resources to treasury (manual adjustment)")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
      )
      .addNumberOption((o) => o.setName("money").setDescription("Money to add"))
      .addNumberOption((o) => o.setName("food").setDescription("Food to add"))
      .addNumberOption((o) => o.setName("munitions").setDescription("Munitions to add"))
      .addNumberOption((o) => o.setName("gasoline").setDescription("Gasoline to add"))
      .addNumberOption((o) => o.setName("steel").setDescription("Steel to add"))
      .addNumberOption((o) => o.setName("aluminum").setDescription("Aluminum to add"))
      .addNumberOption((o) => o.setName("oil").setDescription("Oil to add"))
      .addNumberOption((o) => o.setName("uranium").setDescription("Uranium to add"))
      .addNumberOption((o) => o.setName("bauxite").setDescription("Bauxite to add"))
      .addNumberOption((o) => o.setName("coal").setDescription("Coal to add"))
      .addNumberOption((o) => o.setName("iron").setDescription("Iron to add"))
      .addNumberOption((o) => o.setName("lead").setDescription("Lead to add")),
  )
  .addSubcommand((s) =>
    s
      .setName("sniff_tax_ids")
      .setDescription("Scan recent bank records and suggest tax_id values")
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
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const sub = interaction.options.getSubcommand(true);

    if (sub === "add") {
      const allianceId = interaction.options.getInteger("alliance_id", true)!;
      const delta = buildDeltaFromInteraction(interaction);

      const anyNonZero = Object.values(delta).some((v) => (v ?? 0) !== 0);
      if (!anyNonZero) {
        await interaction.editReply("Provide at least one non-zero resource amount to add.");
        return;
      }

      await addToTreasury(allianceId, delta, {
        source: "manual",
        meta: { actor: interaction.user.id, command: "treasury_add" },
      });

      const pretty = Object.entries(delta)
        .filter(([, v]) => (v ?? 0) !== 0)
        .map(([k, v]) => `• ${k}: ${v}`)
        .join("\n");

      await interaction.editReply(
        [
          `✅ Added to treasury for **${allianceId}**:`,
          pretty || "(no-op?)",
        ].join("\n"),
      );
      return;
    }

    if (sub === "sniff_tax_ids") {
      const allianceId = interaction.options.getInteger("alliance_id", true)!;
      const limit = interaction.options.getInteger("limit") ?? 250;
      const pairs = await sniffTaxIdsUsingStoredKey(allianceId, limit);

      if (!pairs.length) {
        await interaction.editReply(
          `No tax_id values detected in the last ${limit} bank records for alliance **${allianceId}**.`,
        );
        return;
      }

      const lines = pairs.map((p) => `• \`${p.id}\`  (${p.count} hits)`).join("\n");
      await interaction.editReply(
        [
          `**Alliance:** ${allianceId}`,
          `**Lookback:** ${limit} records`,
          `**Detected tax_id values:**`,
          lines,
          "",
          "Tip: set a filter with `/pnw_tax_ids set alliance_id:<id> ids:<list>`",
        ].join("\n"),
      );
      return;
    }

    await interaction.editReply("Unknown subcommand.");
  } catch (err) {
    await replyError(interaction, err);
  }
}
