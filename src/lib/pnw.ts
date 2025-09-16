export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  params: { allianceId: number; afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const { allianceId, afterId, limit = 100, filter = "all" } = params;

  const query = `
    query AllianceBank($aid:Int!, $after:Int, $limit:Int!) {
      alliance(id:$aid) {
        bankRecords(afterId:$after, limit:$limit) {
          id date note sender_id receiver_id sender_type receiver_type amount tax_id tax_note
        }
      }
    }
  `;

  const body = JSON.stringify({
    query,
    variables: { aid: allianceId, after: afterId ?? null, limit: Math.max(1, Math.min(500, limit)) }
  });

  // PnW requires api_key as a query parameter
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
      // NOTE: Do NOT send X-Api-Key; PnW expects the api_key query param.
    },
    body
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0,200)}`);
  }

  const json = await res.json();
  const records: Bankrec[] = json?.data?.alliance?.bankRecords ?? [];
  let filtered = records;
  if (filter === "tax")     filtered = records.filter(r => r.tax_id != null);
  if (filter === "nontax")  filtered = records.filter(r => r.tax_id == null);
  return filtered;
}
