// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { addToTreasury } from "../utils/treasury_store";
import { resourceEmbed } from "../lib/embeds";
import { RESOURCE_KEYS } from "../lib/pnw.js"; // validates keys users provide

export const data = new SlashCommandBuilder()
  .setName("treasury_add")
  .setDescription("Admin: add (or subtract) amounts to the alliance treasury (JSON payload).")
  // REQUIRED FIRST
  .addStringOption((o) =>
    o
      .setName("payload")
      .setDescription('JSON like {"money":1000000,"steel":500} (negative values allowed)')
      .setRequired(true),
  )
  // OPTIONAL AFTER
  .addIntegerOption((o) =>
    o
      .setName("alliance_id")
      .setDescription("Alliance ID (defaults to this server's linked alliance)")
      .setRequired(false),
  )
  .addStringOption((o) =>
    o.setName("note").setDescription("Optional note to include in the reply").setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const payload = i.options.getString("payload", true)!;
    const allianceId = i.options.getInteger("alliance_id") ?? 0; // your env/linking may override 0 elsewhere
    const note = i.options.getString("note") ?? "";

    // Parse & validate payload keys
    const obj = JSON.parse(payload) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      throw new Error("Payload must be a JSON object like {\"money\": 1000000, \"steel\": 500}");
    }

    // Normalize: keep only known resource keys; coerce to numbers
    const normalized: Record<string, number> = {};
    const allowed = new Set(RESOURCE_KEYS as readonly string[]);
    const unknown: string[] = [];

    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();
      if (!allowed.has(key)) {
        unknown.push(k);
        continue;
      }
      const num = Number(v);
      if (!Number.isFinite(num)) {
        throw new Error(`Value for "${k}" must be a number.`);
      }
      normalized[key] = (normalized[key] ?? 0) + num;
    }

    if (Object.keys(normalized).length === 0) {
      const hint = "`" + (RESOURCE_KEYS as readonly string[]).join("`, `") + "`";
      if (unknown.length) {
        throw new Error(
          `No valid resource keys provided. Unknown: ${unknown.join(", ")}.\nValid keys: ${hint}`,
        );
      } else {
        throw new Error(`No resource keys provided. Valid keys: ${hint}`);
      }
    }

    await addToTreasury(allianceId, normalized);

    const lines = Object.entries(normalized)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k.padEnd(12)} ${v >= 0 ? "+" : ""}${v.toLocaleString()}`)
      .join("\n");

    const embed = resourceEmbed({
      title: "Treasury Updated",
      subtitle: `Alliance: ${allianceId || "default"}`,
      fields: [{ name: "Delta", value: "```\n" + lines + "\n```" }],
      color: 0x2ecc71,
      footer: note || undefined,
    });

    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    await i.editReply(`❌ ${err?.message ?? String(err)}`);
  }
}
