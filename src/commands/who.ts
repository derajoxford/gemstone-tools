// src/commands/who.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type User,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "../lib/crypto.js";

const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipherB64: string, nonceB64: string) => string;

const WHO_VERSION = "who-env-2025-09-29b";

type NationCore = {
  id: number;
  name: string;
  leader: string;
  allianceId?: number | null;
  allianceName?: string | null;
  score?: number | null;
  cities?: number | null;
  color?: string | null;
  continent?: string | null;
  soldiers?: number | null;
  tanks?: number | null;
  aircraft?: number | null;
  ships?: number | null;
  spies?: number | null;
  missiles?: number | null;
  nukes?: number | null;
  projects?: number | null;
  founded?: string | null;
  lastActive?: string | null;
};

export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Look up a nation by nation name, leader name, Discord user (linked), or nation ID.")
  .addStringOption(o =>
    o.setName("nation").setDescription("Nation name (full/partial) OR numeric ID").setRequired(false),
  )
  .addStringOption(o =>
    o.setName("leader").setDescription("Leader name (full/partial)").setRequired(false),
  )
  .addUserOption(o =>
    o.setName("user").setDescription("Discord user (uses linked nation if available)").setRequired(false),
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply();
  console.log("[/who]", WHO_VERSION, "invoked", {
    nation: i.options.getString("nation"),
    leader: i.options.getString("leader"),
    userOpt: !!i.options.getUser("user"),
  });

  try {
    const api = await getApiKey();
    if (!api) {
      await i.editReply(
        "Admin setup required: no PNW API key. Set `PNW_API` in the service env (or save an alliance API key) and restart.",
      );
      return;
    }

    const nationArg = (i.options.getString("nation") || "").trim();
    const leaderArg = (i.options.getString("leader") || "").trim();
    const user: User | null = i.options.getUser("user");

    let nation: NationCore | null = null;
    let lookedUp = "";
    let multiNote = "";

    // 0) numeric ID path (fastest + most reliable)
    if (nationArg && /^\d+$/.test(nationArg)) {
      const id = Number(nationArg);
      nation = await fetchNationById(api, id);
      console.log("[/who] ID lookup", { id, found: !!nation });
      lookedUp = `ID ${id}`;
    }

    // 1) nation name search
    if (!nation && nationArg) {
      const res = await searchNations(api, { nationName: nationArg });
      console.log("[/who] nation name results", res.length);
      if (res.length) {
        nation = res[0];
        lookedUp = `nation name "${nationArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 2) leader name search
    if (!nation && leaderArg) {
      const res = await searchNations(api, { leaderName: leaderArg });
      console.log("[/who] leader name results", res.length);
      if (res.length) {
        nation = res[0];
        lookedUp = `leader name "${leaderArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 3) linked Discord user (or self)
    if (!nation && (user || (!nationArg && !leaderArg))) {
      const targetUser = user ?? i.user;
      const member = await prisma.member.findFirst({
        where: { discordId: targetUser.id },
        select: { nationId: true },
      });
      console.log("[/who] linked member", { hasMember: !!member, nationId: member?.nationId });
      if (member?.nationId) {
        nation = await fetchNationById(api, member.nationId);
        lookedUp = `linked nation for <@${targetUser.id}>`;
      }
    }

    if (!nation) {
      await i.editReply(
        "I couldn't find a nation. Try one of:\n" +
          "• `/who nation:<nation name>`\n" +
          "• `/who leader:<leader name>`\n" +
          "• `/who nation:<numeric nation id>`\n" +
          "• `/who user:@member` (requires nation link)",
      );
      return;
    }

    const urlNation = `https://politicsandwar.com/nation/id=${nation.id}`;
    const urlWars = `https://politicsandwar.com/nation/id=${nation.id}&display=war`;
    const urlTrades = `https://politicsandwar.com/nation/id=${nation.id}&display=trade`;
    const alliance = nation.allianceName
      ? `[${nation.allianceName}](https://politicsandwar.com/alliance/id=${nation.allianceId})`
      : "None";

    const embed = new EmbedBuilder()
      .setTitle(`${nation.name} — ${nation.leader}`)
      .setURL(urlNation)
      .setDescription(
        `${multiNote ? multiNote + " • " : ""}Looked up by ${lookedUp || "ID"} • ID: \`${nation.id}\` • ${WHO_VERSION}`,
      )
      .addFields(
        { name: "Alliance", value: alliance, inline: true },
        { name: "Score", value: fmtNum(nation.score), inline: true },
        { name: "Cities", value: fmtNum(nation.cities), inline: true },
        { name: "Soldiers / Tanks", value: `${fmtNum(nation.soldiers)} / ${fmtNum(nation.tanks)}`, inline: true },
        { name: "Aircraft / Ships", value: `${fmtNum(nation.aircraft)} / ${fmtNum(nation.ships)}`, inline: true },
        { name: "Spies / Missiles / Nukes", value: `${fmtNum(nation.spies)} / ${fmtNum(nation.missiles)} / ${fmtNum(nation.nukes)}`, inline: true },
        { name: "Projects", value: fmtNum(nation.projects), inline: true },
        { name: "Color / Continent", value: `${nation.color ?? "—"} / ${nation.continent ?? "—"}`, inline: true },
        {
          name: "Active / Founded",
          value: `${nation.lastActive ? new Date(nation.lastActive).toLocaleString() : "—"}\n${nation.founded ? new Date(nation.founded).toLocaleDateString() : "—"}`,
          inline: true,
        },
      )
      .setTimestamp(new Date());

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Nation").setURL(urlNation),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Wars").setURL(urlWars),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Trades").setURL(urlTrades),
    );

    await i.editReply({ embeds: [embed], components: [row] });
  } catch (err: any) {
    console.error("who execute error:", err);
    await i.editReply("Sorry — something went wrong looking that up.");
  }
}

/* ===================== Helpers & API ===================== */

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Intl.NumberFormat().format(n);
}

function toB64(b: any): string {
  // normalize Buffer/Uint8Array/ArrayBuffer to base64
  // @ts-ignore
  return (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64");
}

async function getApiKey(): Promise<string | null> {
  // 1) Prefer global env key (your key, for everyone)
  const env = process.env.PNW_API?.trim();
  if (env) {
    console.log("[/who] using PNW_API from environment", { len: env.length });
    return env;
  }

  // 2) Fallback to latest stored alliance API key (encrypted)
  try {
    const k = await prisma.allianceKey.findFirst({
      orderBy: { id: "desc" },
      select: { encryptedApiKey: true, nonceApi: true },
    });
    if (k?.encryptedApiKey && k?.nonceApi) {
      const api = open(toB64(k.encryptedApiKey as any), toB64(k.nonceApi as any));
      if (api && api.length > 10) {
        console.log("[/who] using AllianceKey from DB");
        return api;
      }
    }
  } catch (e) {
    console.error("[/who] getApiKey DB error:", e);
  }

  console.warn("[/who] no API key (env or DB)");
  return null;
}

function mapNationGraphQL(n: any): NationCore {
  return {
    id: Number(n.id),
    name: n.nation_name,
    leader: n.leader_name,
    allianceId: n.alliance?.id ? Number(n.alliance.id) : n.alliance_id ? Number(n.alliance_id) : null,
    allianceName: n.alliance?.name ?? null,
    score: safeNum(n.score),
    cities: safeNum(n.cities),
    color: n.color ?? null,
    continent: n.continent ?? null,
    soldiers: safeNum(n.soldiers),
    tanks: safeNum(n.tanks),
    aircraft: safeNum(n.aircraft),
    ships: safeNum(n.ships),
    spies: safeNum(n.spies),
    missiles: safeNum(n.missiles),
    nukes: safeNum(n.nukes),
    projects: safeNum(n.projects),
    founded: n.founded ?? null,
    lastActive: n.last_active ?? null,
  };
}
function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------- GraphQL + REST ---------- */

/**
 * IMPORTANT: embed the numeric ID literally; the variables form sometimes returns 0 rows.
 */
async function fetchNationById(api: string, id: number): Promise<NationCore | null> {
  const gql = `
    {
      nations(id:[${id}], first:1) {
        data {
          id nation_name leader_name
          alliance_id alliance { id name }
          score cities color continent soldiers tanks aircraft ships spies missiles nukes projects
          founded last_active
        }
      }
    }`;

  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });

  if (!r.ok) {
    console.warn("[/who] fetchNationById HTTP", r.status);
    return null;
  }
  const j: any = await r.json().catch(() => ({}));
  const count = j?.data?.nations?.data?.length ?? 0;
  console.log("[/who] fetchNationById rows", count, j?.errors ? JSON.stringify(j.errors) : "");
  const row = count ? j.data.nations.data[0] : null;
  return row ? mapNationGraphQL(row) : null;
}

/**
 * REST keyword search fallback. Returns nation IDs; we hydrate each via GraphQL by ID.
 */
async function restKeywordSearch(api: string, kw: string, limit = 5): Promise<number[]> {
  if (!kw || kw.length < 2) return [];
  const url = `https://api.politicsandwar.com/v3/nations?api_key=${encodeURIComponent(api)}&keyword=${encodeURIComponent(kw)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) {
    console.warn("[/who] REST search HTTP", r.status);
    return [];
  }
  const j: any = await r.json().catch(() => ({}));
  const arr = Array.isArray(j?.data) ? j.data : [];
  console.log("[/who] REST results", arr.length);
  return arr.slice(0, limit).map((n: any) => Number(n?.id)).filter(Boolean);
}

/**
 * Returns up to 5 nations; tries GraphQL (name/leader) first, then REST fallback → hydrate by ID.
 */
async function searchNations(
  api: string,
  opts: { nationName?: string; leaderName?: string },
): Promise<NationCore[]> {
  const kw = (opts.nationName ?? opts.leaderName ?? "").trim();
  const out: NationCore[] = [];
  if (kw.length < 2) return out;

  // GraphQL attempt
  const run = async (variables: any, argLine: string, tag: string) => {
    const gql = `
      query($name:String, $leaders:[String!]) {
        nations(${argLine}, first:5, orderBy:{column:SCORE, order:DESC}) {
          data {
            id nation_name leader_name
            alliance_id alliance { id name }
            score cities color continent soldiers tanks aircraft ships spies missiles nukes projects
            founded last_active
          }
        }
      }`;
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables }),
    });
    if (!r.ok) {
      console.warn("[/who] search HTTP", tag, r.status);
      return;
    }
    const j: any = await r.json().catch(() => ({}));
    const arr = j?.data?.nations?.data ?? [];
    console.log("[/who] GraphQL results", tag, arr.length);
    for (const n of arr) out.push(mapNationGraphQL(n));
  };

  if (opts.nationName) {
    await run({ name: kw }, "name:$name", "name");
  }
  if (opts.leaderName && out.length === 0) {
    await run({ leaders: [kw] }, "leader_name:$leaders", "leader_name");
  }

  // REST fallback if GraphQL yielded nothing
  if (out.length === 0) {
    const ids = await restKeywordSearch(api, kw, 5);
    for (const id of ids) {
      const n = await fetchNationById(api, id);
      if (n) out.push(n);
    }
  }

  // Dedup + rank
  const dedup = new Map<number, NationCore>();
  for (const n of out) dedup.set(n.id, n);
  return Array.from(dedup.values()).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
}
