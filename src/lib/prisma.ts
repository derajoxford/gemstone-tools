// src/lib/prisma.ts
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__prisma__ ??
  new PrismaClient({
    log: ["error", "warn"],
  });

if (!globalThis.__prisma__) globalThis.__prisma__ = prisma;
