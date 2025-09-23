import 'dotenv/config';

const aid = 14258; // your alliance id
const k = process.env.PNW_API_KEY_14258 || process.env.PNW_API_KEY;
if (!k) {
  console.error('No PNW_API_KEY set'); process.exit(1);
}

const url = 'https://api.politicsandwar.com/graphql?api_key=' + encodeURIComponent(k);

const q = `query ($aid:[Int!], $first:Int!, $page:Int!) {
  alliances(id:$aid) {
    data {
      id
      name
      bankrecs(first:$first, page:$page) {
        data {
          id
          date
          note
          banker_id
          money food coal oil uranium lead iron bauxite gasoline munitions steel aluminum
        }
        paginatorInfo { currentPage hasMorePages }
      }
    }
  }
}`;

let total = 0;
for (let page = 1; page <= 5; page++) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { aid: [aid], first: 50, page } })
  });
  const txt = await r.text();
  if (!r.ok) { console.error('HTTP', r.status, txt); process.exit(1); }

  const j = JSON.parse(txt);
  const bucket = j?.data?.alliances?.data?.[0]?.bankrecs;
  const rows = bucket?.data ?? [];
  for (const x of rows.slice(0, 10)) {
    console.log(`${x.id}\t${x.date}\tmoney=${x.money}\tnote="${x.note ?? ''}"`);
  }
  total += rows.length;
  if (!bucket?.paginatorInfo?.hasMorePages) break;
}
console.log('TOTAL rows:', total);
