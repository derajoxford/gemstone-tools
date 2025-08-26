# Gemstone Tools — Alliance Banking (MVP)

TypeScript/Node 20 Discord bot for Politics & War alliance banking + member safekeeping.

## Quick Start
```bash
npm i
cp .env.example .env   # fill values
npx prisma generate
npx prisma db push
npm run dev
```

Commands:
- `/setup_alliance` — save Alliance API key + optional Bot (mutations) key securely
- `/link_nation` — link your Discord user to a PnW nation
- `/balance` — show safekeeping balance
- `/withdraw {"money":1000000}` — request a withdrawal
