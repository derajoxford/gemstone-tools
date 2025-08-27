import fs from 'fs';
const p = 'src/index.ts';
let s = fs.readFileSync(p, 'utf8');

const hasCmd    = s.includes("setName('config_autopay')");
const hasHook   = s.includes("i.commandName === 'config_autopay'");
const hasFn     = s.includes('function handleConfigAutopay(');
const hasToggle = s.includes('(cfg2?.autopayEnabled ?? true)');

function addCommand() {
  const arrStart = s.indexOf('const commands = [');
  const arrEnd   = s.indexOf('].map(c => c.toJSON());', arrStart);
  if (arrStart === -1 || arrEnd === -1) throw new Error('Could not find commands array');
  const before = s.slice(0, arrEnd);
  const after  = s.slice(arrEnd);
  const insert = `,
  new SlashCommandBuilder().setName('config_autopay')
    .setDescription('Enable or disable auto-pay for this alliance')
    .addBooleanOption(o => o.setName('enabled').setDescription('true=on, false=off').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
`;
  s = before.replace(/\]\s*$/, insert + '\n]') + after;
}

function addHook() {
  const anchor = "if (i.commandName === 'set_reviewer_role') return handleSetReviewerRole(i);";
  const idx = s.indexOf(anchor);
  if (idx === -1) throw new Error('Could not find reviewer_role hook');
  s = s.slice(0, idx + anchor.length) + "\n      if (i.commandName === 'config_autopay') return handleConfigAutopay(i);" + s.slice(idx + anchor.length);
}

function addHandler() {
  const marker = '// --- Button approvals + DMs + Auto-Pay ---';
  const idx = s.indexOf(marker);
  const fn = `
async function handleConfigAutopay(i: ChatInputCommandInteraction) {
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'This server is not linked yet. Run /setup_alliance first.', ephemeral: true });

  const enabled = i.options.getBoolean('enabled', true);
  await prisma.allianceConfig.upsert({
    where: { allianceId: alliance.id },
    update: { autopayEnabled: enabled },
    create: { allianceId: alliance.id, autopayEnabled: enabled },
  });
  await i.reply({ content: \`⚙️ Autopay is now **\${enabled ? 'ON' : 'OFF'}** for this alliance.\`, ephemeral: true });
}
`;
  if (idx !== -1) {
    s = s.slice(0, idx) + fn + s.slice(idx);
  } else {
    s += '\n' + fn + '\n';
  }
}

function patchAutopayCondition() {
  const find = "if (status === 'APPROVED' && process.env.AUTOPAY_ENABLED === '1') {";
  if (!s.includes(find)) return; // already patched or code moved
  const replacement =
`const cfg2 = await prisma.allianceConfig.findUnique({ where: { allianceId: req.allianceId } });
  const isAutoEnabled = process.env.AUTOPAY_ENABLED === '1' && (cfg2?.autopayEnabled ?? true);
  if (status === 'APPROVED' && isAutoEnabled) {`;
  s = s.replace(find, replacement);
}

let changed = false;
if (!hasCmd)   { addCommand(); changed = true; }
if (!hasHook)  { addHook();    changed = true; }
if (!hasFn)    { addHandler(); changed = true; }
if (!hasToggle){ patchAutopayCondition(); changed = true; }

if (changed) {
  fs.writeFileSync(p, s);
  console.log('Patched: /config_autopay added and wired.');
} else {
  console.log('No changes needed: /config_autopay already present.');
}
