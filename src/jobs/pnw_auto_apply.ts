// ── src/jobs/pnw_auto_apply.ts ────────────────────────────────────────────────
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    // Build URL with ?api_key=... (PnW v3 GraphQL requires this)
    const base = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";
    const url = new URL(base);
    url.searchParams.set("api_key", apiKey);

    // IMPORTANT: alliances returns an AlliancePaginator -> .data[]
    // bankrecs returns a BankrecPaginator -> .data[]
    const query = `
      {
        alliances(id:[${allianceId}]) {
          data {
            id
            bankrecs(first: 100) {
              data {
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
      console.warn(
        "[auto-credit] PnW API GraphQL errors:",
        json.errors.map((e: any) => e?.message ?? e)
      );
      return [];
    }

    // Expect: { data: { alliances: { data: [ { id, bankrecs: { data:[...] } } ] } } }
    const recs: any[] =
      json?.data?.alliances?.data?.[0]?.bankrecs?.data ?? [];

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
          sender_type: Number(r.sender_type),
          receiver_type: Number(r.receiver_type),
        };
      })
      .filter(
        (r) =>
          r.sender_type === SENDER_NATION &&                  // sender is nation
          (r.receiver_type === 2 || r.receiver_type === 3) && // receiver is AA or Alliance
          r.created_at instanceof Date &&
          !Number.isNaN(r.created_at.getTime()) &&
          r.created_at.getTime() > cutoff
      )
      .sort(
        (a, b) =>
          (a.created_at as Date).getTime() -
          (b.created_at as Date).getTime()
      );

    console.log(
      `[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`
    );
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}
