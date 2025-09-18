// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

type Bankrec = {
  id: string; // numeric but comes back as string
  date: string;
  note: string;
  tax_id: string; // "0" if not a tax record, otherwise bracket id
  sender_type: number; // 1=nation, 2=alliance
  receiver_type: number; // 1=nation, 2=alliance
  sender_id: string;
  receiver_id: string;
};

const GRAPHQL_URL = "https://api.politicsandwar.com/graphql";

/** Get API key (per-alliance override wins) */
function resolveApiKey(allianceId: number): string | undefined {
  const perAlliance = process.env[`PNW_API_KEY_${allianceId}`];
  return perAlliance || process.env.PNW_API_KEY;
}

/** Small delay helper */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull from the global bankrecs feed and filter locally for alliance rows.
 * Stops when we have `limit` rows or hit `maxPages`.
 */
async function fetchAllianceBankrecsFromGlobal(options: {
  allianceId: number;
  limit: number;
  afterId?: string | number | null;
  filter: "all" | "tax" | "nontax";
  maxPages?: number;
}): Promise<Bankrec[]> {
  const { allianceId, limit, afterId, filter, maxPages = 80 } = options;
  const apiKey = resolveApiKey(allianceId);
  if (!apiKey) throw new Error("Alliance key record missing usable apiKey");

  // The public nations query works while alliances(ids){bankrecs} intermittently 500s.
  // Query the global feed and page until we have enough rows.
  const first = 25;
  const vars = (page: number) => ({ first, page });
  const query = /* GraphQL */ `
    query($first:Int!,$page:Int!){
      bankrecs(first:$first,page:$page){
        data{
          id
          date
          note
          tax_id
          sender_type
          receiver_type
          sender_id
          receiver_id
        }
        paginatorInfo{ currentPage hasMorePages }
      }
    }
  `;

  const results: Bankrec[] = [];
  const after = afterId ? String(afterId) : null;

  for (let page = 1; page <= maxPages && results.length < limit; page++) {
    const res = await fetch(`${GRAPHQL_URL}?api_key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: vars(page) }),
    });

    if (!res.ok) {
      const body = await res.text();
      // Surface a friendly error (matches your prior style)
      throw new Error(`PnW GraphQL HTTP ${res.status}: ${body}`);
    }

    const body = await res.json();
    const pageRows: Bankrec[] = body?.data?.bankrecs?.data ?? [];

    // Filter for alliance rows (type 2) where the id matches our alliance
    for (const r of pageRows) {
      const isAllianceSender = r.sender_type === 2 && r.sender_id === String(allianceId);
      const isAllianceReceiver = r.receiver_type === 2 && r.receiver_id === String(allianceId);
      if (!isAllianceSender && !isAllianceReceiver) continue;

      if (after && String(r.id) <= after) continue; // strictly "after"

      // tax vs nontax filter
      const isTax = r.tax_id !== "0";
      if (filter === "tax" && !isTax) continue;
      if (filter === "nontax" && isTax) continue;

      results.push(r);
      if (results.length >= limit) break;
    }

    const hasMore = body?.data?.bankrecs?.paginatorInfo?.hasMorePages ?? false;
    if (!hasMore) break;

    // be polite
    await sleep(150);
  }

  // Newest first by id (ids are increasing over time)
  results.sort((a, b) => Number(b.id) - Number(a.id));
  return results.slice(0, limit);
}

function formatRow(r: Bankrec): string {
  const kind = r.tax_id !== "0" ? "TAX" : "NON-TAX";
  // amount is not exposed on GraphQL bankrecs; keep $0 as before
  const note = r.note?.replace(/&bull;/g, "•") ?? "";
  return `${r.id} • ${r.date} • ${kind} • $0 • ${note}`.slice(0, 200);
}

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Peek alliance bank records via global feed (GraphQL).")
  .addIntegerOption((o) =>
    o
      .setName("alliance_id")
      .setDescription("Alliance ID (required)")
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("filter")
      .setDescription("Filter records")
      .addChoices(
        { name: "all", value: "all" },
        { name: "tax", value: "tax" },
        { name: "nontax", value: "nontax" },
      )
      .setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Max rows to return (default 8)")
      .setMinValue(1)
      .setMaxValue(50)
      .setRequired(false),
  )
  .addStringOption((o) =>
    o
      .setName("after_id")
      .setDescription("Only show records with id > after_id")
      .setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const allianceId = i.options.getInteger("alliance_id", true);
    const filter = (i.options.getString("filter", true) as "all" | "tax" | "nontax") || "all";
    const limit = i.options.getInteger("limit") ?? 8;
    const after_id = i.options.getString("after_id") ?? undefined;

    const rows = await fetchAllianceBankrecsFromGlobal({
      allianceId,
      limit,
      afterId: after_id,
      filter,
    });

    if (!rows.length) {
      await i.editReply(
        `Alliance ${allianceId} • after_id=${after_id ?? "-"} • filter=${filter} • limit=${limit}\n\nNo bank records found.`,
      );
      return;
    }

    const lines = rows.map((r) => formatRow(r)).join("\n");
    await i.editReply(
      `Alliance ${allianceId} • after_id=${after_id ?? "-"} • filter=${filter} • limit=${limit}\n\n${lines}`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await i.editReply(`❌ ${msg}`);
  }
}
