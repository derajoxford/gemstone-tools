// src/commands/pnw_tax_apply.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import prisma from "../utils/db";
import { getTreasury, setTreasury, addBags, ResourceBag } from "../lib/treasury";

// NOTE: We rely on Node 18+ global fetch. No node-fetch import.
type TaxrecRow = {
  id: string;               // PnW id as string
  date: string;             // ISO string
  note?: string | null;
  sender_type: number;
  sender_id: string;
  receiver_type: number;
  receiver_id: string;

  // Expect these fields on taxrecs (numbers returned as strings by PnW API)
  money?: string | number;
  food?: string | number;
  coal?: string | number;
  oil?: string | number;
  uranium?: string | number;
  lead?: string | number;
  iron?: string | number;
  bauxite?: string | number;
  gasoline?: string | number;
  munitions?: string | number;
  steel?: string | number;
  aluminum?: string | number;
};

function toNum(x: any): number {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function sumRow(r: TaxrecRow): ResourceBag {
  return {
    money:     toNum(r.money),
    food:      toNum(r.food),
    coal:      toNum(r.coal),
    oil:       toNum(r.oil),
    uranium:   toNum(r.uranium),
    lead:      toNum(r.lead),
    iron:      toNum(r.iron),
    bauxite:   toNum(r.bauxite),
    gasoline:  toNum(r.gasoline),
    munitions: toNum(r.munitions),
    steel:     toNum(r.steel),
    aluminum:  toNum(r.aluminum),
  };
}

async function fetchAllianceTaxrecs(apiKey: string, allianceId: number, limit: number): Promise<TaxrecRow[]> {
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);

  // We request all resource fields in case the API exposes them (many endpoints do).
  // If some are absent, they’ll coerce to 0 by toNum().
  const q = `
    query($aid:[Int!], $limit:Int) {
      alliances(id:$aid) {
        data {
          id
          name
          taxrecs(limit:$limit) {
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
    }`;

  const body = JSON.stringify({ query: q, variables: { aid: [allianceId], limit } });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const j = await r.json();

  if (j.errors) {
    throw new Error("PnW GraphQL errors: " + JSON.stringify(j.errors));
  }

  const data = j.data?.alliances?.data?.[0];
  if (!data) return [];
  return (data.taxrecs as TaxrecRow[]) || [];
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Fetch recent taxrecs and credit them to the alliance treasury (idempotent).")
  .addIntegerOption(opt =>
    opt.setName("alliance_id").setDescription("PnW alliance id").setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName("limit").setDescription("How many most-recent taxrecs to scan (default 200)").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = interaction.options.getInteger("limit") ?? 200;

  // Resolve API key from env: PNW_API_KEY_<AID> or PNW_API_KEY
  const envKey = process.env[`PNW_API_KEY_${allianceId}`];
  const apiKey = envKey || process.env.PNW_API_KEY || process.env.PNW_API_KEY_14258;
  if (!apiKey) {
    throw new Error(`No PNW API key found in env (PNW_API_KEY_${allianceId} or PNW_API_KEY)`);
  }

  // Current treasury + last applied id
  const { balances } = await getTreasury(prisma, allianceId);
  const lastAppliedId = String((balances as any)._lastTaxId || "");

  const rows = await fetchAllianceTaxrecs(apiKey, allianceId, limit);

  // Keep only taxes TO this alliance, and strictly newer than last applied id (lexically compare as numbers)
  const filtered = rows
    .filter(r => Number(r.receiver_type) === 2 && Number(r.receiver_id) === allianceId)
    .sort((a, b) => Number(a.id) - Number(b.id));

  const startIdx = lastAppliedId ? filtered.findIndex(r => Number(r.id) > Number(lastAppliedId)) : 0;
  const applyRows = startIdx < 0 ? [] : filtered.slice(startIdx);

  // Sum resources to apply
  let delta: ResourceBag = {};
  for (const r of applyRows) {
    delta = addBags(delta, sumRow(r));
  }

  // Newest id we are applying this run
  const newestId = applyRows.length ? applyRows[applyRows.length - 1].id : lastAppliedId;

  // Apply to treasury (balances is free-form JSON)
  const nextBalances: any = addBags(balances as any, delta);
  if (newestId) nextBalances._lastTaxId = String(newestId);
  await setTreasury(prisma, allianceId, nextBalances);

  // Pretty embed
  const fmt = (n?: number) => (n && Math.abs(n) > 0 ? n.toLocaleString("en-US") : "0");
  const embed = new EmbedBuilder()
    .setTitle(`Tax Apply • Alliance ${allianceId}`)
    .setDescription(
      applyRows.length
        ? `Applied **${applyRows.length}** new tax records.\nNewest taxrec id: **${newestId}**.`
        : `No new tax records to apply.\nLast applied id: **${lastAppliedId || "—"}**.`
    )
    .addFields(
      { name: "Money", value: fmt(delta.money), inline: true },
      { name: "Food", value: fmt(delta.food), inline: true },
      { name: "Coal", value: fmt(delta.coal), inline: true },
      { name: "Oil", value: fmt(delta.oil), inline: true },
      { name: "Uranium", value: fmt(delta.uranium), inline: true },
      { name: "Lead", value: fmt(delta.lead), inline: true },
      { name: "Iron", value: fmt(delta.iron), inline: true },
      { name: "Bauxite", value: fmt(delta.bauxite), inline: true },
      { name: "Gasoline", value: fmt(delta.gasoline), inline: true },
      { name: "Munitions", value: fmt(delta.munitions), inline: true },
      { name: "Steel", value: fmt(delta.steel), inline: true },
      { name: "Aluminum", value: fmt(delta.aluminum), inline: true },
    )
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}
