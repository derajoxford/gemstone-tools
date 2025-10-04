-- Create OffshoreLedger table (PostgreSQL)
CREATE TABLE IF NOT EXISTS "OffshoreLedger" (
  "id"                 SERIAL PRIMARY KEY,
  "allianceId"         INTEGER    NOT NULL,
  "offshoreId"         INTEGER    NOT NULL,
  "lastSeenBankrecId"  INTEGER    NOT NULL DEFAULT 0,
  "money"              NUMERIC    NOT NULL DEFAULT 0,
  "food"               NUMERIC    NOT NULL DEFAULT 0,
  "coal"               NUMERIC    NOT NULL DEFAULT 0,
  "oil"                NUMERIC    NOT NULL DEFAULT 0,
  "uranium"            NUMERIC    NOT NULL DEFAULT 0,
  "lead"               NUMERIC    NOT NULL DEFAULT 0,
  "iron"               NUMERIC    NOT NULL DEFAULT 0,
  "bauxite"            NUMERIC    NOT NULL DEFAULT 0,
  "gasoline"           NUMERIC    NOT NULL DEFAULT 0,
  "munitions"          NUMERIC    NOT NULL DEFAULT 0,
  "steel"              NUMERIC    NOT NULL DEFAULT 0,
  "aluminum"           NUMERIC    NOT NULL DEFAULT 0,
  "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite unique so we can upsert/find on (allianceId, offshoreId)
CREATE UNIQUE INDEX IF NOT EXISTS "OffshoreLedger_allianceId_offshoreId_key"
  ON "OffshoreLedger" ("allianceId","offshoreId");

-- speeds scanning new records for a given offshore alliance
CREATE INDEX IF NOT EXISTS idx_alliance_bankrec_aid_id
ON alliance_bankrec (alliance_id_derived, id);
