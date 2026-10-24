// copy-standalone.mjs — copy the static assets into the standalone build.
//
// The build script used to call `cp -r`, which does not exist on Windows.
// This script does the same thing on every platform.
//
// Run: node scripts/copy-standalone.mjs   (after `next build`)

import { cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(from, to) {
  if (!(await exists(from))) {
    console.log(`skip (missing): ${path.relative(root, from)}`);
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`copied: ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

await copyDir(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'));
await copyDir(path.join(root, 'public'), path.join(standalone, 'public'));
await copyDir(
  path.join(root, 'prisma'),
  path.join(standalone, 'prisma')
);
