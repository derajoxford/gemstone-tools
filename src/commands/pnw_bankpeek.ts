// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecs, BankrecRow } from "../lib/pnw";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Peek recent alliance bankrecs via PnW GraphQL (debug/ops).")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("How many rows (default 50, max ~600)")
  )
  .addStringOption(o =>
    o.setName("filter")
      .setDescription('Contains text (e.g. "tax" or "Automated Tax")')
  )
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const allianceId = i.options.getInteger("alliance_id", true);
  const limit = Math.max(1, Math.min(600, i.options.getInteger("limit") ?? 50));
  const filter = (i.options.getString("filter") || "").toLowerCase();

  // Find API key for this alliance (stored by /pnw_set)
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId: allianceId },
    orderBy: { id: "desc" },
  });

  if (!k) {
    return i.editReply("❌ No stored API key. Run /pnw_set first (and ensure GT_SECRET matches).");
  }

  // Decrypt (your open() helper lives in lib/crypto in your repo)
  // If your code stores plaintext, replace the next 3 lines with reading the string.
  const { open } = await import("../lib/crypto.js");
  const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
  if (!apiKey) return i.editReply("❌ Failed to decrypt API key. Check GT_SECRET/ENCRYPTION_KEY.");

  // Fetch
  let rows: BankrecRow[] = [];
  try {
    const res = await fetchBankrecs({ apiKey }, [allianceId], limit);
    rows = res[0]?.bankrecs ?? [];
  } catch (err: any) {
    return i.editReply(`❌ Fetch failed: ${err?.message || String(err)}`);
  }

  // Optional filter by note text
  if (filter) {
    rows = rows.filter(r => (r.note || "").toLowerCase().includes(filter));
  }

  if (!rows.length) {
    return i.editReply(`(filter=${filter || "none"}) No rows found in the recent window.`);
  }

  // Format safely under Discord's 2000-char limit
  const lines = rows.map(r => {
    const dir = `${r.sender_type}→${r.receiver_type}`;
    const money = Number(r.money || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const note = (r.note || "").replace(/\s+/g, " ").slice(0, 100);
    return `#${r.id} | ${r.date} | ${dir} | $${money} | ${note}`;
  });

  let out = lines.join("\n");
  if (out.length > 1800) {
    // trim from the end
    let n = lines.length;
    while (out.length > 1800 && n > 1) {
      n--;
      out = lines.slice(0, n).join("\n") + `\n…(${lines.length - n} more)`;
    }
  }

  await i.editReply("```\n" + out + "\n```");
}
