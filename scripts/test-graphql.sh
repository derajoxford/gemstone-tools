#!/usr/bin/env bash
set -euo pipefail
read -r -s -p "Enter a NATION API KEY (hidden): " APIKEY; echo
APIKEY="$APIKEY" npx tsx scripts/test-graphql.ts
