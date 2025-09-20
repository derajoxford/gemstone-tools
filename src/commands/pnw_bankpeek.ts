import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  bold,
  inlineCode,
} from "discord.js";

import {
  queryAllianceBankrecs,
  getAllianceCursor,
  setAllianceCursor,
  applyPeekFilter,
  type BankrecRow,
  type BankrecFilter,
} from "../lib/pnw_bank_ingest";

// --- helpers ---
function toInt(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function fmtRow(r: BankrecRow): string {
  const id = r.id;
  const when = r.date?.replace("T", " ").replace("+00:00", "Z");
  const s = r.sender_type === 2 ? `A:${r.sender_id}` : `N:${r.sender_id}`;
  const t = r.receiver_type === 2 ? `A:${r.receiver_id}` : `N:${r.receiver_id}`;
  const note = (r.note ?? "").slice(0, 140);
  return `#${id} • ${when} • ${s} → ${t} • ${note}`;
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Peek at recent alliance bank records via PnW GraphQL")
  .addIntegerOption((opt) =>
    opt
      .setName("alliance_id")
      .setDescription("Alliance ID (e.g., 14258)")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("filter")
      .setDescription("Filter rows")
      .addChoices(
        { name: "all", value: "all" },
        { name: "tax", value: "tax" },
        { name: "nontax", value: "nontax" },
      )
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("limit")
      .setDescription("Max rows to show (1-100)")
      .setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("after_id")
      .setDescription("Only rows with id > after_id")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // pull options robustly and validate
  const aidOpt =
    interaction.options.getInteger("alliance_id") ??
    interaction.options.getInteger("allianceId") ??
    interaction.options.getInteger("aid");
  const allianceId = toInt(aidOpt);
  if (!allianceId) {
    return interaction.editReply("❌ Error: Invalid alliance_id (must be a positive integer).");
  }

  const filter = (interaction.options.getString("filter") ?? "all") as BankrecFilter;
  const limit = Math.max(
    1,
    Math.min(toInt(interaction.options.getInteger("limit")) ?? 10, 100)
  );
  const afterId = toInt(interaction.options.getInteger("after_id") ?? undefined) ?? undefined;

  try {
    const rows = await queryAllianceBankrecs(
      // pass undefined prisma so we can still work off env keys;
      // if you want DB-backed keys, wire your prisma instance here.
      undefined,
      allianceId,
      filter,
      limit,
      afterId ?? (await getAllianceCursor(undefined, allianceId) ?? undefined)
    );

    const shown = rows.slice(0, limit);
    const header =
      `${bold(`Alliance ${allianceId}`)} • ` +
      `after_id=${inlineCode(String(afterId ?? "-"))} • ` +
      `filter=${inlineCode(filter)} • ` +
      `limit=${inlineCode(String(limit))}`;

    if (shown.length === 0) {
      await interaction.editReply(`${header}\n\nNo bank records found.`);
      return;
    }

    const newest = toInt(shown[0]?.id) ?? null; // Graph returns newest-first
    if (newest != null) {
      // best-effort cursor save (safe no-op if no DB wired)
      await setAllianceCursor(undefined, allianceId, newest);
    }

    const body = shown.map(fmtRow).join("\n");
    await interaction.editReply(`${header}\n\n${body}`);
  } catch (e: any) {
    await interaction.editReply(`❌ Error: ${e?.message ?? String(e)}`);
  }
}

export const commandMeta = {
  name: "pnw_bankpeek",
};
