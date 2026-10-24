// start-prod.mjs — start the production server (cross-platform).
//
// It does three things the bare `bun .next/standalone/server.js` does not:
//
//   1. loads the variables of `.env` into the process environment,
//   2. rewrites a RELATIVE `DATABASE_URL` to an absolute path — Prisma
//      resolves a relative sqlite path against the schema folder, and the
//      standalone build ships its own copy of the schema,
//   3. reports the token state (production is fail-closed without a token).
//
// Usage: node scripts/start-prod.mjs [--port 3000] [--host 0.0.0.0]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const port = arg('port', process.env.PORT || '3000');
const host = arg('host', process.env.HOSTNAME || '0.0.0.0');

// --- 1) .env ----------------------------------------------------------------
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] === undefined) process.env[key] = value.trim();
  }
  console.log('[start] .env loaded');
}

// --- 2) DATABASE_URL --------------------------------------------------------
const dbFile = path.join(root, 'db', 'custom.db');
if (process.env.DATABASE_URL?.startsWith('file:')) {
  const target = process.env.DATABASE_URL.slice('file:'.length).trim();
  if (target && !path.isAbsolute(target)) {
    const absolute = path.resolve(root, 'prisma', target);
    process.env.DATABASE_URL = `file:${absolute.split(path.sep).join('/')}`;
    console.log(`[start] DATABASE_URL -> ${process.env.DATABASE_URL}`);
  }
}
if (!fs.existsSync(dbFile)) {
  console.warn(`[start] the database file was not found at ${dbFile} — run "prisma db push" first`);
}

// --- 3) token ---------------------------------------------------------------
if (process.env.AGENTSCOPE_API_TOKEN) {
  console.log('[start] AGENTSCOPE_API_TOKEN is configured');
} else {
  console.warn(
    '[start] AGENTSCOPE_API_TOKEN is NOT set — every mutating API call will be rejected (fail-closed). ' +
      'Set it in .env, or AGENTSCOPE_ALLOW_UNAUTHENTICATED=1 for a local-only deployment.'
  );
}

// --- run --------------------------------------------------------------------
const server = path.join(root, '.next', 'standalone', 'server.js');
if (!fs.existsSync(server)) {
  console.error(`[start] the standalone build is missing at ${server} — run "bun run build" first`);
  process.exit(1);
}

process.env.NODE_ENV = 'production';
process.env.PORT = String(port);
process.env.HOSTNAME = host;

console.log(`[start] serving on http://localhost:${port}`);
const child = spawn(process.execPath, [server], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
