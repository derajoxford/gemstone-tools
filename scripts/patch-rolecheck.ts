import fs from 'fs';
const p = 'src/index.ts';
let s = fs.readFileSync(p,'utf8');

const start = s.indexOf('// Permission gate:');
const end = s.indexOf("const [prefix, action, id] = i.customId.split(':';", start);
if (start === -1 || end === -1) {
  console.error('Could not locate markers in src/index.ts');
  process.exit(1);
}

// Build the new permission block: no network fetch, checks roles from interaction
const replacement = `// Permission gate:
// If a reviewer role is configured, require that role.
// Otherwise, fallback to ManageGuild permission (same as before).
const alliance = await prisma.alliance.findFirst({
  where: { guildId: i.guildId },
  include: { config: true }
});
const reviewerRoleId = alliance?.config?.reviewerRoleId;
if (reviewerRoleId) {
  let hasRole = false;
  const mem: any = i.member;
  if (mem) {
    // For APIInteractionGuildMember (uncached) roles is string[]
    if (Array.isArray(mem.roles)) {
      hasRole = mem.roles.includes(reviewerRoleId);
    } else if (mem.roles && mem.roles.cache) {
      // For cached GuildMember, roles.cache is a Collection
      hasRole = mem.roles.cache.has(reviewerRoleId);
    }
  }
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
const after = s.slice(end);
fs.writeFileSync(p, before + replacement + after);
console.log('Patched role gate successfully.');
