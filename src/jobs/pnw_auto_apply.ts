/** Live PnW API fallback (GraphQL) — alliances → bankrecs. */
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    // Build URL with ?api_key=... (reliable for PnW v3 GraphQL)
    const base = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";
    const url = new URL(base);
    url.searchParams.set("api_key", apiKey);

    // alliances(id:[AID]) { id bankrecs { ... } }
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
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      console.warn("[auto-credit] PnW API GraphQL errors:", json.errors.map((e: any) => e?.message ?? e));
      return [];
    }

    // Expect: { data: { alliances: [ { id, bankrecs: [...] } ] } }
    const recs: any[] = json?.data?.alliances?.[0]?.bankrecs ?? [];
    const cutoff = since.getTime();

    const mapped = recs
      .map((r) => {
        const d = new Date(String(r.date));
        const created_at = Number.isNaN(d.getTime()) ? new Date(0) : d;
        return {
          ...r,
          id: String(r.id),
          created_at,
          alliance_id_derived: allianceId,
          // coerce to numbers so our filters are robust
          sender_type: Number(r.sender_type),
          receiver_type: Number(r.receiver_type),
        };
      })
      .filter(
        (r) =>
          r.sender_type === 1 &&                 // nation
          r.receiver_type === 3 &&               // alliance
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
