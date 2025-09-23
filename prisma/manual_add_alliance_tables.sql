-- Create alliance_api_keys if it doesn't exist
CREATE TABLE IF NOT EXISTS "alliance_api_keys" (
  "allianceId" INTEGER PRIMARY KEY,
  "apiKey"     TEXT    NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create alliance_bank_cursors if it doesn't exist
CREATE TABLE IF NOT EXISTS "alliance_bank_cursors" (
  "allianceId" INTEGER PRIMARY KEY,
  "lastSeenId" TEXT    NOT NULL,
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
