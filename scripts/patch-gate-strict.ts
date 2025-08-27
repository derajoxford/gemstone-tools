import fs from 'fs';
const p = 'src/index.ts';
let s = fs.readFileSync(p,'utf8');

const start = s.indexOf('// Permission gate:');
const end   = s.indexOf("const [prefix, action, id] = i.customId.split(':';", start);
if (start === -1 || end === -1) { console.error('Could not locate permission block.'); process.exit(1); }

const replacement = `// Permission gate:
// Require the configured reviewer role strictly (no admin bypass).
// If this server isn't linked to an alliance, block the action.
const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId } });
if (!alliance) {
  console.log('APPROVAL_GATE_NO_ALLIANCE', { guildId: i.guildId, userId: i.user.id });
  return i.reply({ content: 'This server is not linked to an alliance. Ask an admin to run /setup_alliance.', ephemeral: true });
}
const cfg = await prisma.allianceConfig.findUnique({ where: { allianceId: alliance.id } });
const reviewerRoleId = cfg?.reviewerRoleId ?? null;

// gather roles from interaction (uncached or cached)
const mem: any = i.member;
let rolesFromInteraction: string[] = [];
if (Array.isArray(mem?.roles)) {
  rolesFromInteraction = mem.roles as string[];                 // APIInteractionGuildMember
} else if (mem?.roles?.cache) {
  rolesFromInteraction = Array.from(mem.roles.cache.keys());    // Cached GuildMember
}

const hasRole = reviewerRoleId ? rolesFromInteraction.includes(reviewerRoleId) : false;

console.log('APPROVAL_GATE', JSON.stringify({
  guildId: i.guildId, userId: i.user.id,
  allianceId: alliance.id,
  reviewerRoleId, rolesFromInteraction, hasRole
}));

if (reviewerRoleId) {
  if (!hasRole) {
    return i.reply({ content: "You Ain't a Banker....PHUCKER!!", ephemeral: true });
  }
} else {
  return i.reply({ content: 'No reviewer role configured. An admin must run /set_reviewer_role.', ephemeral: true });
}
`;

const before = s.slice(0, start);
const after  = s.slice(end);
fs.writeFileSync(p, before + replacement + after);
console.log('Patched: strict reviewer-role gate with no-alliance block + debug logs.');
