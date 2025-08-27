#!/usr/bin/env bash
set -euo pipefail
if [ -f .env ]; then
  CLIENT_ID="$(grep -E '^DISCORD_CLIENT_ID=' .env | cut -d= -f2- || true)"
fi
if [ -z "${CLIENT_ID:-}" ]; then
  read -r -p "Enter Discord Application (Client) ID: " CLIENT_ID
fi

# Minimal perms: Send Messages, Embed Links, Read Message History, Use External Emojis
PERMS=346112
URL="https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot%20applications.commands&permissions=${PERMS}"

echo
echo "👉 Invite URL:"
echo "$URL"
echo
echo "You can paste this into a browser to add the bot to any server where you have permission."
