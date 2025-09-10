// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { getAllianceReadKey } from "../integrations/pnw/store";
import { pnwQuery } from "../integrations/pnw/query";

async function replyError(i: ChatInputCommandInteraction, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await i.editReply(`❌ ${msg}`);
  console.error("[/pnw_bankpeek] error:", err);
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: show the latest alliance bank records (raw fields)")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Records to fetch (default 20, max 100)")
      .setMinValue(1)
      .setMaxValue(100),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

const TICK_BLOCK_OPEN = "```";
const TICK_BLOCK_CLOSE = "```";
const MAX_CHUNK = 1800; // keep well under 2000 hard cap

function toLine(r: any) {
  const id = r?.id ?? "?";
  const date = r?.date ?? "?";
  const st = r?.stype ?? "?";
  const rt = r?.rtype ?? "?";
  const tid = r?.tax_id ?? "-";
  const money = r?.money ?? 0;
  let note = String(r?.note ?? "");
  if (note.length > 80) note = note.slice(0, 77) + "…";
  return `#${id} | ${date} | ${st}→${rt} | $${money} | tax_id:${tid} | ${note}`;
}

function isTaxRow(r: any) {
  const note: string = String(r?.note ?? "");
  const rtype = String(r?.rtype ?? "").toLowerCase();
  return /\bautomated\s*tax\b/i.test(note) && rtype === "alliance";
}

function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const line of lines) {
    const addLen = line.length + 1;
    if (curLen + addLen > MAX_CHUNK) {
      chunks.push(cur.join("\n"));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += addLen;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const limit = interaction.options.getInteger("limit") ?? 20;

    const apiKey = await getAllianceReadKey(allianceId);

    const query = /* GraphQL */ `
      query AllianceBankrecs($ids: [Int], $limit: Int!) {
        alliances(id: $ids) {
          data {
            id
            bankrecs(limit: $limit) {
              id
              date
              note
              stype
              rtype
              money
              food
              munitions
              gasoline
              steel
              aluminum
              oil
              uranium
              bauxite
              coal
              iron
              lead
              tax_id
            }
          }
        }
      }
    `;
    const vars: any = { ids: [allianceId], limit };
    const data: any = await pnwQuery(apiKey, query, vars);

    const alliances = Array.isArray(data?.alliances?.data)
      ? data.alliances.data
      : Array.isArray(data?.alliances)
      ? data.alliances
      : [];

    const recs: any[] = alliances?.[0]?.bankrecs ?? [];

    if (!recs.length) {
      await interaction.editReply(
        `Alliance **${allianceId}** — no bank records returned (limit ${limit}).`,
      );
      return;
    }

    // Sort tax-looking rows first so they’re easy to spot.
    const sorted = [...recs].sort((a, b) => Number(isTaxRow(b)) - Number(isTaxRow(a)));
    const taxCount = sorted.reduce((n, r) => n + (isTaxRow(r) ? 1 : 0), 0);
    const lines = sorted.map(toLine);

    const header = `Alliance **${allianceId}** — latest ${recs.length} bank records (tax first, detected ${taxCount} tax-like rows)`;
    const chunks = chunkLines(lines);

    if (chunks.length === 1) {
      await interaction.editReply(
        [header, TICK_BLOCK_OPEN, chunks[0], TICK_BLOCK_CLOSE].join("\n"),
      );
    } else {
      await interaction.editReply(
        `${header}\nOutput split across ${chunks.length} messages (ephemeral).`,
      );
      for (const c of chunks) {
        await interaction.followUp({
          ephemeral: true,
          content: [TICK_BLOCK_OPEN, c, TICK_BLOCK_CLOSE].join("\n"),
        });
      }
    }
  } catch (err) {
    await replyError(interaction, err);
  }
}
