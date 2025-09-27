/** Live PnW API fallback (GraphQL) — alliances → bankrecs. */
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    // Build URL with ?api_key=... (works reliably for PnW v3 GraphQL)
    const base = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";
    const url = new URL(base);
    url.searchParams.set("api_key", apiKey);

    // alliances(id:[AID]) { id bankrecs { ... } }
    // We request all resource columns so we can increment balances directly.
    const query = `
      {
        alliances(id:[${allianceId}]) {
          id
          bankrecs {
            id
            date
            note
            sender_type
            sender_id
            receiver_type
            receiver_id
            money
            food
            coal
            oil
            uranium
            lead
            iron
            bauxite
            gasoline
            munitions
            steel
            aluminum
          }
        }
      }
    `;

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      console.warn(`[auto-credit] PnW API HTTP ${resp.status} for alliance ${allianceId}`);
      return [];
    }

    const json: any = await resp.json();
    // Expect shape: { data: { alliances: [ { id, bankrecs: [...] } ] } }
    const alliances = json?.data?.alliances;
    const list: any[] = Array.isArray(alliances) && alliances[0]?.bankrecs
      ? alliances[0].bankrecs
      : [];

    const cutoff = since.getTime();
    const mapped = list
      .map((r) => {
        // PnW returns date as string; parse to Date
        const d = new Date(String(r.date));
        return {
          ...r,
          id: String(r.id),
          created_at: d,
          alliance_id_derived: allianceId,
        };
      })
      .filter((r) =>
        r.sender_type === 1 &&                      // nation
        r.receiver_type === 3 &&                    // alliance
        r.created_at instanceof Date &&
        !Number.isNaN(r.created_at.getTime()) &&
        r.created_at.getTime() > cutoff
      )
      .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());

    console.log(
      `[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`
    );
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}
