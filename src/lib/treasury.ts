// src/lib/treasury.ts
import { PrismaClient } from "@prisma/client";

export type ResourceBag = {
  money?: number;
  food?: number;
  coal?: number;
  oil?: number;
  uranium?: number;
  lead?: number;
  iron?: number;
  bauxite?: number;
  gasoline?: number;
  munitions?: number;
  steel?: number;
  aluminum?: number;
};

type BalancesJSON = ResourceBag & { _lastTaxId?: string };

function add(a = 0, b = 0) {
  return Number(a) + Number(b);
}

export function addBags(a: ResourceBag = {}, b: ResourceBag = {}): ResourceBag {
  return {
    money:     add(a.money,     b.money),
    food:      add(a.food,      b.food),
    coal:      add(a.coal,      b.coal),
    oil:       add(a.oil,       b.oil),
    uranium:   add(a.uranium,   b.uranium),
    lead:      add(a.lead,      b.lead),
    iron:      add(a.iron,      b.iron),
    bauxite:   add(a.bauxite,   b.bauxite),
    gasoline:  add(a.gasoline,  b.gasoline),
    munitions: add(a.munitions, b.munitions),
    steel:     add(a.steel,     b.steel),
    aluminum:  add(a.aluminum,  b.aluminum),
  };
}

export async function getTreasury(prisma: PrismaClient, allianceId: number) {
  let row = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  if (!row) {
    row = await prisma.allianceTreasury.create({
      data: { allianceId, balances: {} },
    });
  }
  const balances = (row.balances as BalancesJSON) || {};
  return { row, balances };
}

export async function setTreasury(prisma: PrismaClient, allianceId: number, balances: BalancesJSON) {
  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    create: { allianceId, balances },
    update: { balances },
  });
}
