// clear-audit-log.ts — empty the audit trail from the command line.
//
// The same thing can be done from the UI (Audit panel → clear) or with
// `DELETE /api/audit`. This script is handy after a test run or when the
// trail has to be archived.
//
// Run: bun run scripts/clear-audit-log.ts

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const before = await db.auditLog.count();
const removed = await db.auditLog.deleteMany({});

console.log(`audit trail cleared: ${removed.count} row(s) removed (${before} before)`);

await db.$disconnect();
