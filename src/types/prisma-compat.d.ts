// src/types/prisma-compat.d.ts
// Make Prisma.WithdrawStatus available for existing code that references it.
declare namespace Prisma {
  type WithdrawStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID' | 'CANCELED';
}
