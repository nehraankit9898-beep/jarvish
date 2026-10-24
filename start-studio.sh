#!/bin/bash
# AgentScope Studio — one-shot start (Mac/Linux)
set -e
cd "$(dirname "$0")/studio"

if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  if command -v bun >/dev/null 2>&1; then bun install; else npm install; fi
fi

echo "🗄️  Preparing database..."
npx prisma db push --skip-generate >/dev/null 2>&1 || npx prisma db push

echo "🚀 Starting AgentScope Studio → http://localhost:3000"
if command -v bun >/dev/null 2>&1; then bun run dev; else npm run dev; fi
