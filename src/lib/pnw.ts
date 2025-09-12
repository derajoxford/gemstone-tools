// src/lib/pnw.ts
// Minimal PnW GraphQL helpers focused on alliance->bankrecs

export type Bankrec = {
  id: number;
  date: string;
  sender_type: number;
  sender_id: number;
  receiver_type: number;
  receiver_id: number;
  money: number;
  food: number;
  coal: number;
  oil: number;
  uranium: number;
  lead: number;
  iron: number;
  bauxite: number;
  gasoline: number;
  munitions: number;
  steel: number;
  aluminum: number;
  note?: string | null;
  tax_id?: number | null;
};

type AlliancesBankrecsResp = {
  data?: {
    alliances: Array<{
      id: number;
      bankrecs: Array<Partial<Bankrec>>;
    }>;
  };
  errors?: any;
};

const GQL = `query($ids:[Int!]) {
  alliances(id:$ids) {
    id
    bankrecs {
      id
      date
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
      note
      tax_id
    }
  }
}`;

export async function fetchAllianceBankrecsViaGQL(opts: {
  apiKey: string;
  allianceId: number;
}): Promise<Bankrec[]> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(
    opts.apiKey
  )}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: GQL, variables: { ids: [opts.allianceId] } }),
  });

  const json = (await res.json().catch(() => ({}))) as AlliancesBankrecsResp;

  if (!res.ok || json.errors) {
    const msg = `PnW GraphQL error (status ${res.status}): ${
      json?.errors ? JSON.stringify(json.errors) : "Unknown error"
    }`;
    throw new Error(msg);
  }

  const rows = json?.data?.alliances?.[0]?.bankrecs ?? [];
  // Normalize + coerce numeric fields
  return rows.map((r: any) => ({
    id: Number(r.id) || 0,
    date: String(r.date || ""),
    sender_type: Number(r.sender_type) || 0,
    sender_id: Number(r.sender_id) || 0,
    receiver_type: Number(r.receiver_type) || 0,
    receiver_id: Number(r.receiver_id) || 0,
    money: Number(r.money) || 0,
    food: Number(r.food) || 0,
    coal: Number(r.coal) || 0,
    oil: Number(r.oil) || 0,
    uranium: Number(r.uranium) || 0,
    lead: Number(r.lead) || 0,
    iron: Number(r.iron) || 0,
    bauxite: Number(r.bauxite) || 0,
    gasoline: Number(r.gasoline) || 0,
    munitions: Number(r.munitions) || 0,
    steel: Number(r.steel) || 0,
    aluminum: Number(r.aluminum) || 0,
    note: r.note ?? null,
    tax_id: typeof r.tax_id === "number" ? r.tax_id : r.tax_id ? Number(r.tax_id) : 0,
  }));
}
