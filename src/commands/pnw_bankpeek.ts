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

function formatRow(r: BankrecRow): string {
  const when = new Date(r.date).toLocaleString();
  const head = `#${r.id} • ${when} • sender ${r.sender_type}:${r.sender_id} → receiver ${r.receiver_type}:${r.receiver_id}`;
  const note = r.note && r.note.trim() ? r.note : "—";
  const parts: string[] = [];

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

  for (const k of keys) {
    const v = Number((r as any)[k] ?? 0);
    if (v) parts.push(`${String(k)}:${v.toLocaleString()}`);
  }

  return `${head}\n${note}\n${parts.join(" · ")}`;
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Peek recent alliance bank records via GraphQL (stored key).")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("How many to fetch (<=500). Default 100.")
      .setRequired(false),
  )
  .addStringOption((o) =>
    o
      .setName("filter")
      .setDescription('Optional filter, e.g. "tax"')
      .setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const limit = Math.max(1, Math.min(interaction.options.getInteger("limit") ?? 100, 500));
    const filter = (interaction.options.getString("filter") || "").toLowerCase();

    // load stored API key
    const k = await prisma.allianceKey.findFirst({
      where: { allianceId },
      orderBy: { id: "desc" },
    });
    if (!k) {
      return interaction.editReply(
        "❌ No stored API key. Run **/pnw_set** first (and ensure server secrets match).",
      );
    }
    const apiKey = open(k.encryptedApiKey, k.nonceApi);

    const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });

    let used = rows;
    if (filter === "tax") {
      used = rows.filter((r) => isTaxBankrec(r, allianceId));
    }

    const header = `Bankpeek${filter ? ` (filter=${filter})` : ""}\nAlliance: ${allianceId}\nFetched: ${used.length} (raw: ${rows.length}, limit: ${limit})`;

    const lines = used.slice(0, 15).map(formatRow); // keep the output readable
    const body = lines.length ? lines.join("\n\n") : "—";

    await interaction.editReply(`${header}\n\n${body}`);
  } catch (err: any) {
    console.error("[/pnw_bankpeek] error:", err);
    await interaction.editReply(`❌ Fetch failed: ${err?.message ?? String(err)}`);
  }
}
