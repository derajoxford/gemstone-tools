// src/commands/pnw_bankpeek.ts
import {
  resolveAllianceApiKey,
  queryAllianceBankrecs,
  type PeekFilter,
} from '../lib/pnw_bank_ingest';

type Args = {
  alliance_id: number;
  filter?: 'all' | 'tax' | 'nontax';
  limit?: number;
  after_id?: string;
};

function parseArgs(input: string): Args {
  // crude parser: "/pnw_bankpeek alliance_id:14258 filter:tax limit:8"
  const m = Object.fromEntries(
    input
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(1) // drop the command name
      .map((kv) => {
        const i = kv.indexOf(':');
        if (i === -1) return [kv, 'true'];
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
  ) as any;

  const alliance_id = Number(m.alliance_id ?? m.allianceId);
  const filter = (m.filter ?? 'all') as PeekFilter;
  const limit = Math.max(1, Math.min(50, Number(m.limit ?? 8)));
  const after_id = m.after_id ?? m.afterId ?? undefined;

  if (!Number.isFinite(alliance_id) || alliance_id <= 0) {
    throw new Error('alliance_id is required and must be a positive number');
  }

  if (!['all', 'tax', 'nontax'].includes(filter)) {
    throw new Error('filter must be one of: all | tax | nontax');
  }

  return { alliance_id, filter, limit, after_id };
}

export async function execute(rawInput: string): Promise<string> {
  // Parse
  let args: Args;
  try {
    args = parseArgs(rawInput);
  } catch (e: any) {
    return `❌ ${e.message}`;
  }

  const { alliance_id, filter = 'all', limit = 8, after_id } = args;

  // Resolve API key
  const apiKey = await resolveAllianceApiKey(alliance_id);
  if (!apiKey) {
    return `❌ Alliance key record missing usable apiKey`;
  }

  // Query (fail fast)
  let rows;
  try {
    rows = await queryAllianceBankrecs({
      allianceId: alliance_id,
      filter,
      limit,
      afterId: after_id,
      apiKey,
    });
  } catch (e: any) {
    // Surface short message so the bot doesn't hang
    return `❌ ${e.message?.slice(0, 200) || 'Fetch failed'}`;
  }

  const heading = `Alliance ${alliance_id} • after_id=${after_id ?? '-'} • filter=${filter} • limit=${limit}`;

  if (!rows || rows.length === 0) {
    return `${heading}\n\nNo bank records found.`;
  }

  // format lines
  const lines = rows.map((r) => {
    const taxTag = r.tax_id && r.tax_id !== '0' ? 'TAX' : 'NON-TAX';
    const dir =
      r.sender_type === 2 && r.sender_id === String(alliance_id)
        ? 'OUT'
        : r.receiver_type === 2 && r.receiver_id === String(alliance_id)
          ? 'IN'
          : 'MISC';
    return `#${r.id} • ${r.date} • ${dir} • ${taxTag} • ${r.note}`;
  });

  return `${heading}\n\n` + lines.join('\n');
}
