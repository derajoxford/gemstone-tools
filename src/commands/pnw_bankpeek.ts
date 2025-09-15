// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { open } from "../lib/crypto.js";
import {
  fetchAllianceBankrecsViaGQL,
  type BankrecRow,
} from "../lib/pnw.js";
import { isTaxBankrec } from "../integrations/pnw/tax.js";

const prisma = new PrismaClient();

// Show up to this many rows in the message body (avoid Discord length issues)
const SHOW_MAX = 15;

function fmtNum(n: number) {
  return Number(n).toLocaleString(undefined);
}

function fmtDate(iso: string) {
  // Rely on server TZ; if you prefer UTC, use new Date(iso).toUTCString()
  return new Date(iso).toLocaleString();
}

function rowResources(r: BankrecRow): string {
  const keys: (keyof BankrecRow)[] = [
    "money",
    "food",
    "coal",
    "oil",
    "uranium",
    "lead",
    "iron",
    "bauxite",
    "gasoline",
    "munitions",
    "steel",
    "aluminum",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    const v = Number(r[k] ?? 0);
    if (!v) continue;
    parts.push(`${k}:${fmtNum(v)}`);
  }
  return parts.join(" · ") || "—";
}

async function getStoredApiKey(allianceId: number): Promise<string> {
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!k) throw new Error("No stored API key. Run /pnw_set first.");
  return open(k.encryptedApiKey, k.nonceApi);
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: fetch recent bankrecs from PnW GQL for an alliance")
  // Required options MUST come before any optional (Discord rule)
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Rows to fetch (default 100, max 500)")
      .setRequired(false),
  )
  .addStringOption((o) =>
    o
      .setName("filter")
      .setDescription("Optional filter")
      .setRequired(false)
      .addChoices({ name: "tax", value: "tax" }),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  // Always defer immediately to avoid the 3s interaction timeout
  await interaction.deferReply({ ephemeral: true });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const limitOpt = interaction.options.getInteger("limit") ?? 100;
    const filter = (interaction.options.getString("filter") || "").toLowerCase();

    const limit = Math.max(1, Math.min(limitOpt, 500));
    const apiKey = await getStoredApiKey(allianceId);

    const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });

    let shown = rows;
    if (filter === "tax") {
      shown = rows.filter((r) => isTaxBankrec(r, allianceId));
    }

    const header =
      filter === "tax"
        ? `Bankpeek (filter=tax)\nAlliance: ${allianceId}\nFetched: ${shown.length} (raw: ${rows.length}, limit: ${limit})\n`
        : `Bankpeek\nAlliance: ${allianceId}\nFetched: ${shown.length} (raw: ${rows.length}, limit: ${limit})\n`;

    if (shown.length === 0) {
      await interaction.editReply(header + "\n— no rows —");
      return;
    }

    const lines: string[] = [];
    const subset = shown.slice(0, SHOW_MAX);
    for (const r of subset) {
      const hdr = `#${r.id} • ${fmtDate(r.date)} • sender ${r.sender_type}:${r.sender_id} → receiver ${r.receiver_type}:${r.receiver_id}`;
      const note = (r.note && r.note.trim()) ? r.note.trim() : "—";
      const res = rowResources(r);
      lines.push(hdr + "\n" + note + "\n" + res + "\n");
    }
    if (shown.length > subset.length) {
      lines.push(`… and ${shown.length - subset.length} more`);
    }

    await interaction.editReply(header + "\n" + lines.join("\n"));
  } catch (err: any) {
    console.error("[/pnw_bankpeek] error:", err);
    const msg =
      err?.message?.startsWith("PnW GraphQL error")
        ? `❌ ${err.message}`
        : `❌ ${err?.message ?? String(err)}`;
    await interaction.editReply(msg);
  }
}
