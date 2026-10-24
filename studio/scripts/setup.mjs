// Repeatable local setup. Never resets the database or accepts data loss.
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'db'), { recursive: true });
const envFile = path.join(root, '.env');
if (!existsSync(envFile)) {
  writeFileSync(envFile, [
    'DATABASE_URL="file:../db/custom.db"',
    `AGENTSCOPE_SECRET_KEY="${randomBytes(32).toString('hex')}"`,
    '# Before exposing this app, configure AGENTSCOPE_API_TOKEN and enter it in UI Settings.',
    '# AGENTSCOPE_API_TOKEN=""',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Created private .env configuration. Keep it out of version control.');
} else {
  console.log('Using existing .env (not modified).');
}
for (const args of [['generate'], ['db', 'push']]) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), ...args], {
    cwd: root, stdio: 'inherit', env: process.env,
  });
  if (result.error || result.status !== 0) {
    console.error('Setup stopped. Check DATABASE_URL and network access to Prisma engine downloads. Existing data has not been reset.');
    process.exit(result.status || 1);
  }
}
console.log('Database ready. Run npm run dev, then connect and test a provider in API Setup.');
