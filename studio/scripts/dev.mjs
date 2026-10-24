// dev.mjs — start the Next dev server and mirror the output into dev.log.
//
// The old script was `next dev -p 3000 2>&1 | tee dev.log`, which only works
// where a POSIX `tee` exists — on Windows the shell reports
// "bun: command not found: tee" and the server never starts.
//
// This script does the same thing on every platform: it spawns `next dev`,
// writes every line to stdout AND to dev.log, and forwards the exit code.
//
// Usage: node scripts/dev.mjs [--port 3000] [--host 0.0.0.0]

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

const port = String(arg('port', process.env.PORT || '3000'));
const host = String(arg('host', '0.0.0.0'));

const logPath = path.join(root, 'dev.log');
const log = fs.createWriteStream(logPath, { flags: 'a' });

console.log(`[dev] logging to ${logPath}`);

const nextBin = path.join(
  root,
  'node_modules',
  'next',
  'dist',
  'bin',
  'next'
);

const child = spawn(process.execPath, [nextBin, 'dev', '-p', port, '-H', host], {
  cwd: root,
  env: { ...process.env, PORT: port, HOSTNAME: host },
  stdio: ['inherit', 'pipe', 'pipe'],
});

function relay(stream, target) {
  stream.setEncoding('utf-8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      process[target].write(`${line}\n`);
      log.write(`${line}\n`);
    }
  });
}

relay(child.stdout, 'stdout');
relay(child.stderr, 'stderr');

child.on('exit', (code, signal) => {
  log.end();
  process.exit(code ?? (signal ? 1 : 0));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
