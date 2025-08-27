import fs from 'fs';
const p = 'src/index.ts';
let s = fs.readFileSync(p, 'utf8');

// 1) Drop "include: { config: true }" from the findFirst call
s = s.replace(/,\s*include:\s*\{\s*config:\s*true\s*\}\s*/m, '');

// 2) Replace "const reviewerRoleId = alliance?.config?.reviewerRoleId;" with fetching AllianceConfig
s = s.replace(
  /const reviewerRoleId = alliance\?\.\s*config\?\.\s*reviewerRoleId\s*;/,
  `const cfg = alliance ? await prisma.allianceConfig.findUnique({ where: { allianceId: alliance.id } }) : null;
  const reviewerRoleId = cfg?.reviewerRoleId;`
);

fs.writeFileSync(p, s);
console.log('Patched: removed include(config) and now load AllianceConfig via separate query.');
