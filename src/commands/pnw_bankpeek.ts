// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { open } from "../lib/crypto";
import { fetchBankrecs } from "../lib/pnw";

const prisma = new PrismaClient();
const toInt = (v: any) => Number.parseInt(String(v ?? 0), 10) || 0;
const toNum = (v: any) => Number.parseFloat(String(v ?? 0)) || 0;

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: peek recent alliance bankrecs (capped).")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("filter")
      .setDescription("Filter")
      .addChoices(
        { name: "all", value: "all" },
        { name: "tax", value: "tax" }
      )
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const allianceId = i.options.getInteger("alliance_id", true)!;
    const filter = i.options.getString("filter") ?? "all";

    const a = await prisma.alliance.findUnique({
      where: { id: allianceId },
      include: { keys: { orderBy: { id: "desc" }, take: 1 } },
    });
    const k = a?.keys?.[0];
    const apiKey =
      (k ? open(k.encryptedApiKey as any, k.nonceApi as any) : null) ||
      process.env.PNW_DEFAULT_API_KEY ||
      "";

    if (!apiKey) {
      return i.editReply(
        "❌ No stored API key. Run /pnw_set first (and ensure secrets match)."
      );
    }

    const res = (await fetchBankrecs({ apiKey }, [allianceId])) || [];
    const rows: any[] = (res[0]?.bankrecs as any[]) || [];

    const maxLines = 25;
    const lines: string[] = [];
    let total = 0;

    for (const r of rows) {
      const incomingToAlliance =
        toInt(r.receiver_type) === 2 && toInt(r.receiver_id) === allianceId;

      const taxId = toInt(r.tax_id);
      const note = String(r.note || "");
      const isTax = incomingToAlliance && (taxId > 0 || /automated\s*tax/i.test(note));

      if (filter === "tax" && !isTax) continue;

      total++;
      if (lines.length < maxLines) {
        const money = toNum(r.money);
        lines.push(
          `#${toInt(r.id)} | ${r.date || ""} | ${toInt(
            r.sender_type
          )}→${toInt(r.receiver_type)} | $${money.toLocaleString()} | tax_id:${taxId} | ${note || ""}`
        );
      }
    }

    if (!total) {
      await i.editReply(`(filter=${filter}) No rows found in the recent window.`);
      return;
    }

    const header =
      filter === "tax"
        ? `Alliance ${allianceId} — TAX records in recent window: ${total}`
        : `Alliance ${allianceId} — ALL records in recent window: ${total}`;

    let body = "```\n" + lines.join("\n") + "\n```";
    if (total > maxLines) {
      body += `\n(+${total - maxLines} more not shown)`;
    }
    await i.editReply(`${header}\n${body}`);
  } catch (err: any) {
    console.error("[/pnw_bankpeek] error:", err);
    await i.editReply(`❌ ${err?.message ?? String(err)}`);
  }
}
