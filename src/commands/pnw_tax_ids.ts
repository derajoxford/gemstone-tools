// src/commands/pnw_tax_ids.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL } from "../lib/pnw";

const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_ids")
  .setDescription("Legacy tax-id utilities (diagnostic).")
  .addSubcommand(sc =>
    sc
      .setName("sniff")
      .setDescription("Diagnose automated-tax detection by scanning recent bankrecs.")
      .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
      .addIntegerOption(o =>
        o.setName("limit").setDescription("How many recent bankrecs to scan (default 300, max 1000)").setRequired(false),
      ),
  )
  .addSubcommand(sc =>
    sc
      .setName("get")
      .setDescription("Show the current (legacy) tax-id filter (deprecated).")
      .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)),
  )
  .addSubcommand(sc =>
    sc
      .setName("set")
      .setDescription("Set a (legacy) tax-id filter (deprecated; no-op).")
      .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
      .addStringOption(o => o.setName("value").setDescription("Ignored").setRequired(true)),
  )
  .addSubcommand(sc =>
    sc
      .setName("clear")
      .setDescription("Clear the (legacy) tax-id filter (deprecated; no-op).")
      .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  try {
    const sub = i.options.getSubcommand(true);

    if (sub === "sniff") {
      const allianceId = i.options.getInteger("alliance_id", true)!;
      const limit = Math.max(1, Math.min(1000, i.options.getInteger("limit") ?? 300));

      const k = await prisma.allianceKey.findFirst({ where: { allianceId }, orderBy: { id: "desc" } });
      if (!k) throw new Error(`No stored API key for alliance ${allianceId}. Run /pnw_set first.`);
      const apiKey = open(k.encryptedApiKey, k.nonceApi);

      const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });
      const taxRows = rows.filter(r => r.tax_id != null && Number(r.tax_id) > 0);

      await i.editReply(
        [
          `PnW tax-id sniff`,
          `Alliance: ${allianceId}`,
          `Scanned: ${rows.length}`,
          `Detected tax rows: ${taxRows.length}`,
          `Latest tax id: ${taxRows[0]?.id ?? "—"}`,
        ].join("\n"),
      );
      return;
    }

    if (sub === "get") {
      const allianceId = i.options.getInteger("alliance_id", true)!;
      await i.editReply(
        `Legacy tax-id filter for ${allianceId}: (deprecated) — using GraphQL field \`tax_id\` now.`,
      );
      return;
    }

    if (sub === "set" || sub === "clear") {
      const allianceId = i.options.getInteger("alliance_id", true)!;
      await i.editReply(
        `No-op. Legacy filter for ${allianceId} is deprecated; detection uses GraphQL \`tax_id\`.`,
      );
      return;
    }
  } catch (err: any) {
    await i.editReply(`❌ ${err?.message ?? String(err)}`);
  }
}
