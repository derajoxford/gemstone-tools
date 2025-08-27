import fs from 'fs';
const p = 'src/index.ts';
let s = fs.readFileSync(p,'utf8');

const start = s.indexOf('// Permission gate:');
const end   = s.indexOf("const [prefix, action, id] = i.customId.split(':';", start);
if (start === -1 || end === -1) { console.error('Could not locate permission block.'); process.exit(1); }

const replacement = `// Permission gate:
// If a reviewer role is configured, require that role (no admin bypass).
// Otherwise, require ManageGuild.
const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId } });
const cfg = alliance ? await prisma.allianceConfig.findUnique({ where: { allianceId: alliance.id } }) : null;
const reviewerRoleId = cfg?.reviewerRoleId;

const mem: any = i.member;
let rolesFromInteraction: string[] = [];
if (Array.isArray(mem?.roles)) {
  // APIInteractionGuildMember.roles: string[]
  rolesFromInteraction = mem.roles as string[];
} else if (mem?.roles?.cache) {
  // Cached GuildMember
  rolesFromInteraction = Array.from(mem.roles.cache.keys());
}

const hasRole = reviewerRoleId ? rolesFromInteraction.includes(reviewerRoleId) : false;

// log what we see from Discord for this click
console.log('APPROVAL_GATE', JSON.stringify({
  guildId: i.guildId, userId: i.user.id,
  reviewerRoleId, rolesFromInteraction, hasRole,
  hasManageGuild: i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? null
}));

if (reviewerRoleId) {
  if (!hasRole) {
    return i.reply({ content: "You Ain't a Banker....PHUCKER!!", ephemeral: true });
  }
} else {
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: 'You lack permission to approve/deny.', ephemeral: true });
  }
}
`;

const before = s.slice(0, start);
const after  = s.slice(end);
fs.writeFileSync(p, before + replacement + after);
console.log('Patched: strict reviewer-role gate with debug logging.');
