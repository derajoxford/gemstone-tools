// src/commands/pnw_bankpeek.ts
import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { open } from "../lib/crypto.js";
import {
  fetchAllianceBankrecsViaGQL,
  fetchAllianceMemberNationIds,
  fetchNationBankrecsViaGQL,
  isAutomatedTaxRow,
  BankrecRow,
} from "../lib/pnw.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: fetch recent bankrecs from PnW GQL for an alliance")
  .setDefaultMemberPermissions(32)
  .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .addIntegerOption(o => o.setName("limit").setDescription("Rows to fetch (default 100, max 500)"))
  .addStringOption(o =>
    o
      .setName("filter")
      .setDescription("Optional filter")
      .addChoices({ name: "tax", value: "tax" }),
  );

export async function execute(i: ChatInputCommandInteraction) {
  const allianceId = i.options.getInteger("alliance_id", true);
  const limit = Math.max(1, Math.min(500, i.options.getInteger("limit") ?? 100));
  const filter = i.options.getString("filter") || "";

  await i.deferReply({ ephemeral: true });

  const k = await prisma.allianceKey.findFirst({ where: { allianceId }, orderBy: { id: "desc" } });
  if (!k) return i.editReply("❌ No stored API key. Run /pnw_set first.");
  const apiKey = open(k.encryptedApiKey, k.nonceApi);

  let rows: BankrecRow[] = [];
  let source: "members" | "alliance" = "alliance";

  if (filter === "tax") {
    const memberIds = await fetchAllianceMemberNationIds(apiKey, allianceId);
    const nationRows = await fetchNationBankrecsViaGQL(apiKey, memberIds, Math.max(5, Math.min(50, Math.ceil(limit / Math.max(1, memberIds.length)) * 5)));
    rows = nationRows.filter(r => isAutomatedTaxRow(r, allianceId));
    source = "members";
  } else {
    rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });
    source = "alliance";
  }

  const rawCount = rows.length;
  rows = rows.slice(0, limit);

  if (filter === "tax") {
    // newest first
    rows.sort((a, b) => b.id - a.id);
  }

  const lines: string[] = [];
  lines.push(`Bankpeek${filter ? ` (filter=${filter})` : ""}`);
  lines.push(`Alliance: ${allianceId}`);
  lines.push(`Fetched: ${rows.length} (raw: ${rawCount}, source: ${source})`);
  lines.push("");

  const show = rows.slice(0, 10);
  for (const r of show) {
    const header = `#${r.id} • ${new Date(r.date).toLocaleString()} • sender ${r.sender_type}:${r.sender_id} → receiver ${r.receiver_type}:${r.receiver_id}`;
    const note = (r.note || "—").replace(/&bull;/g, "•");
    const parts: string[] = [];
    if (r.money) parts.push(`money:${r.money.toLocaleString()}`);
    if (r.food) parts.push(`food:${r.food.toLocaleString()}`);
    if (r.uranium) parts.push(`uranium:${r.uranium.toLocaleString()}`);
    if (r.aluminum) parts.push(`aluminum:${r.aluminum.toLocaleString()}`);
    if (r.steel) parts.push(`steel:${r.steel.toLocaleString()}`);
    lines.push(header);
    lines.push(note);
    lines.push(parts.length ? parts.join(" · ") : "—");
    lines.push("");
  }

  await i.editReply({ content: lines.join("\n") });
}
