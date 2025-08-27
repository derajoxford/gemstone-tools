#!/usr/bin/env bash
set -euo pipefail
read -r -p "Enter your Discord Server (Guild) ID: " GID

# write/update TEST_GUILD_ID in .env without touching other keys
if grep -q '^TEST_GUILD_ID=' .env 2>/dev/null; then
  sed -i "s/^TEST_GUILD_ID=.*/TEST_GUILD_ID=${GID}/" .env
else
  echo "TEST_GUILD_ID=${GID}" >> .env
fi
chmod 600 .env

# run the TypeScript registrar
npx tsx scripts/register-guild-commands.ts
