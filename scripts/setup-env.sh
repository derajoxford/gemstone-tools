#!/usr/bin/env bash
set -euo pipefail

echo "Gemstone Tools — interactive .env setup"
echo

prompt_hidden() {  # $1 varname, $2 label
  local __var="$1" __label="$2" __val
  read -r -s -p "$__label: " __val
  echo
  printf -v "$__var" "%s" "$__val"
}

prompt() {        # $1 varname, $2 label, $3 default(optional)
  local __var="$1" __label="$2" __def="${3-}" __val
  if [ -n "$__def" ]; then
    read -r -p "$__label [$__def]: " __val
    __val="${__val:-$__def}"
  else
    read -r -p "$__label: " __val
  fi
  printf -v "$__var" "%s" "$__val"
}

# --- Discord ---
prompt_hidden DISCORD_TOKEN "Enter Discord Bot Token (hidden)"
prompt DISCORD_CLIENT_ID "Enter Discord Application (Client) ID"

echo
echo "Database connection (press Enter to accept defaults from your DO setup)"
# Defaults based on what you gave me; you can change them here:
prompt DB_HOST "DB host" "gemstone-tools-do-user-5059199-0.i.db.ondigitalocean.com"
prompt DB_PORT "DB port" "25060"
prompt DB_NAME "DB name" "defaultdb"   # okay to keep defaultdb
prompt DB_USER "DB username" "gemstone"
prompt_hidden DB_PASS "DB password (hidden)"

echo
read -r -p "Add optional fallback PNW API key? (y/N): " yn_api
if [[ "${yn_api,,}" == "y" ]]; then prompt_hidden PNW_DEFAULT_API_KEY "PNW API Key"; else PNW_DEFAULT_API_KEY=""; fi
read -r -p "Add optional fallback PNW Bot (Mutations) key? (y/N): " yn_bot
if [[ "${yn_bot,,}" == "y" ]]; then prompt_hidden PNW_DEFAULT_BOT_KEY "PNW Bot Key"; else PNW_DEFAULT_BOT_KEY=""; fi

# Generate a 32-byte encryption key
ENC_KEY="base64:$(openssl rand -base64 32)"

# Compose DATABASE_URL (assumes password has no special URL-breaking chars)
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require"

cat > .env <<ENV
DISCORD_TOKEN=$DISCORD_TOKEN
DISCORD_CLIENT_ID=$DISCORD_CLIENT_ID
ENCRYPTION_KEY=$ENC_KEY
DATABASE_URL=$DATABASE_URL
PNW_DEFAULT_API_KEY=$PNW_DEFAULT_API_KEY
PNW_DEFAULT_BOT_KEY=$PNW_DEFAULT_BOT_KEY
ENV

chmod 600 .env
echo
echo "✅ .env created (permissions set to 600)."
echo "Encryption key generated and stored. You can rotate it later if needed."
