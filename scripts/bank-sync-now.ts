import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { open } from '../src/lib/crypto.js';
import { fetchBankrecs } from '../src/lib/pnw.js';

const prisma = new PrismaClient();
const toInt = (v:any) => Number.parseInt(String(v), 10) || 0;
const toNum = (v:any) => Number.parseFloat(String(v)) || 0;

(async () => {
  const alliances = await prisma.alliance.findMany({ include: { keys: { orderBy: { id: 'desc' }, take: 1 } } });
  if (!alliances.length) { console.log('No alliances configured.'); process.exit(0); }

  for (const a of alliances) {
    const k = a.keys[0];
    if (!k) { console.log(`Alliance ${a.id}: no key saved`); continue; }
    const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);

    const data = await fetchBankrecs({ apiKey }, [a.id]);
    const al = data?.[0];
    if (!al || !al.bankrecs) { console.log(`Alliance ${a.id}: bankrecs null (no bank permission?)`); continue; }

    let last = a.lastBankrecId || 0;
    const rows = (al.bankrecs as any[]).filter(r => toInt(r.id) > last).sort((x,y)=>toInt(x.id)-toInt(y.id));
    console.log(`Alliance ${a.id}: ${rows.length} new bankrecs since ${last || 0}`);

    for (const r of rows) {
      const recId = toInt(r.id);
      await prisma.bankrec.upsert({
        where: { id: recId },
        update: {},
        create: {
          id: recId,
          allianceId: a.id,
          date: new Date(r.date),
          note: r.note || null,
          senderType: toInt(r.sender_type),
          senderId: toInt(r.sender_id),
          receiverType: toInt(r.receiver_type),
          receiverId: toInt(r.receiver_id),
          money: toNum(r.money),
          food: toNum(r.food),
          coal: toNum(r.coal),
          oil: toNum(r.oil),
          uranium: toNum(r.uranium),
          lead: toNum(r.lead),
          iron: toNum(r.iron),
          bauxite: toNum(r.bauxite),
          gasoline: toNum(r.gasoline),
          munitions: toNum(r.munitions),
          steel: toNum(r.steel),
          aluminum: toNum(r.aluminum),
        }
      });

      // nation (1) -> alliance (2) == deposit to alliance
      const isDeposit = toInt(r.sender_type) === 1 && toInt(r.receiver_type) === 2 && toInt(r.receiver_id) === a.id;
      if (isDeposit) {
        const member = await prisma.member.findFirst({ where: { allianceId: a.id, nationId: toInt(r.sender_id) } });
        if (member) {
          await prisma.safekeeping.upsert({
            where: { memberId: member.id },
            update: {
              money: { increment: toNum(r.money) },
              food: { increment: toNum(r.food) },
              coal: { increment: toNum(r.coal) },
              oil: { increment: toNum(r.oil) },
              uranium: { increment: toNum(r.uranium) },
              lead: { increment: toNum(r.lead) },
              iron: { increment: toNum(r.iron) },
              bauxite: { increment: toNum(r.bauxite) },
              gasoline: { increment: toNum(r.gasoline) },
              munitions: { increment: toNum(r.munitions) },
              steel: { increment: toNum(r.steel) },
              aluminum: { increment: toNum(r.aluminum) },
            },
            create: { memberId: member.id }
          });
          console.log(`  • Credited deposit from nation ${toInt(r.sender_id)} to member ${member.discordId}`);
        } else {
          console.log(`  • Deposit from nation ${toInt(r.sender_id)}, but no linked member found`);
        }
      }

      last = Math.max(last, recId);
    }

    if (last && last !== (a.lastBankrecId || 0)) {
      await prisma.alliance.update({ where: { id: a.id }, data: { lastBankrecId: last } });
      console.log(`Alliance ${a.id}: cursor advanced to ${last}`);
    }
  }
  process.exit(0);
})();
