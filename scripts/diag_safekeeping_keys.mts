import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

function numericish(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}

async function main() {
  const discordId = process.env.DISCORD_ID || "";
  let member =
    (discordId && (await prisma.member.findFirst({ where: { discordId } }))) ||
    (await prisma.member.findFirst({ orderBy: { id: "desc" } }));

  if (!member) {
    console.error("No Member rows found.");
    process.exit(2);
  }

  let safe =
    (await prisma.safekeeping.findFirst({ where: { memberId: member.id } })) ||
    (await prisma.safekeeping.findFirst({
      where: { member: { discordId: discordId || member.discordId } },
      include: { member: true },
    }));

  if (!safe) {
    console.error("Member has no Safekeeping row.");
    process.exit(3);
  }

  const nonZero: Record<string, number> = {};
  for (const [k, v] of Object.entries(safe)) {
    if (numericish(v)) nonZero[k] = Number(v as any);
  }
  console.log("Non-zero safekeeping fields:", nonZero);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
