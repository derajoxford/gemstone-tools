#!/usr/bin/env bash
set -euo pipefail
read -r -p "Alliance ID: " AID
read -r -s -p "Alliance API Key (hidden): " APIKEY
echo
AID="$AID" APIKEY="$APIKEY" npx tsx scripts/set-alliance-key.ts
