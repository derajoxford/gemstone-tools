import { PrismaClient } from "@prisma/client";
import { fetchAveragePrices, computeTotalValue } from "../src/lib/market.js";

const prisma = new PrismaClient();

async function main() {
  const discordId = process.env.DISCORD_ID || "";
  let member: any = null;

  if (discordId) {
    member = await prisma.member.findFirst({ where: { discordId } });
  }
  if (!member) {
    member = await prisma.member.findFirst({ orderBy: { id: "desc" } });
  }
  if (!member) {
    console.error("No Member rows found.");
    process.exit(2);
  }

  let safe = await prisma.safekeeping.findFirst({ where: { memberId: member.id } });
  if (!safe) {
    const viaSafe = await prisma.safekeeping.findFirst({
      where: { member: { discordId: discordId || member.discordId } },
      include: { member: true },
    });
    if (viaSafe) {
      safe = viaSafe;
      member = viaSafe.member;
    }
  }
  if (!safe) {
    console.error("Member has no Safekeeping row.");
    process.exit(3);
  }

  const pricing = await fetchAveragePrices();
  console.log("pricing source:", pricing?.source, "asOf:", pricing?.asOf);
  console.log("price keys:", Object.keys(pricing?.prices || {}));

  const keys = [
    "money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum",
  ] as const;

  const nonZero: Record<string, number> = {};
  for (const k of keys) {
    const v = Number((safe as any)[k] || 0);
    if (v > 0) nonZero[k] = v;
  }
  console.log("non-zero safekeeping:", nonZero);

  const total = computeTotalValue(nonZero as any, pricing?.prices || { money: 1 });
  console.log("computed total:", Math.round(total).toLocaleString("en-US"));
}

main().catch((e) => { console.error(e); process.exit(1); });

