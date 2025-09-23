INSERT INTO "alliance_api_keys" ("allianceId","apiKey")
VALUES (:aid, :key)
ON CONFLICT ("allianceId") DO UPDATE
SET "apiKey" = EXCLUDED."apiKey",
    "updatedAt" = NOW();
