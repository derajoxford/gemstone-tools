import fs from 'fs';
const p = 'src/index.ts';
let s = fs.readFileSync(p, 'utf8');

// 1) Add the /config_autopay command to the commands array
{
  const start = s.indexOf('const commands = [');
  const end   = s.indexOf('].map(c => c.toJSON());', start);
  if (start === -1 || end === -1) throw new Error('commands array not found');
  const before = s.slice(0, end);
  const after  = s.slice(end);
  const insert = `,
  new SlashCommandBuilder().setName('config_autopay')
    .setDescription('Enable or disable auto-pay for this alliance')
    .addBooleanOption(o => o.setName('enabled').setDescription('true=on, false=off').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
`;
  s = before.replace(/\]\s*$/, insert + '\n]') + after;
}

// 2) Hook the handler
{
  const hookAfter = "if (i.commandName === 'set_reviewer_role') return handleSetReviewerRole(i);";
  const idx = s.indexOf(hookAfter);
  if (idx === -1) throw new Error('hook point not found');
  s = s.slice(0, idx + hookAfter.length) + "\n      if (i.commandName === 'config_autopay') return handleConfigAutopay(i);" + s.slice(idx + hookAfter.length);
}

// 3) Add the handler function (before approvals section marker)
{
  const marker = '// --- Button approvals + DMs + Auto-Pay ---';
  const idx = s.indexOf(marker);
  if (idx === -1) throw new Error('approvals marker not found');
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
  s = s.slice(0, idx) + fn + s.slice(idx);
}

// 4) Respect the toggle inside the APPROVED path (env must still allow AUTOPAY_ENABLED=1)
{
  const find = "if (status === 'APPROVED' && process.env.AUTOPAY_ENABLED === '1') {";
  const idx = s.indexOf(find);
  if (idx === -1) throw new Error('autopay condition not found');
  const replacement = `const cfg2 = await prisma.allianceConfig.findUnique({ where: { allianceId: req.allianceId } });
  const isAutoEnabled = process.env.AUTOPAY_ENABLED === '1' && (cfg2?.autopayEnabled ?? true);
  if (status === 'APPROVED' && isAutoEnabled) {`;
  s = s.replace(find, replacement);
}

fs.writeFileSync(p, s);
console.log('Added /config_autopay and wired alliance toggle.');
