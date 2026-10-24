#!/usr/bin/env bash
# build-release.sh — build the clean distributable archive.
#
# The archive is produced from `git ls-files` plus the untracked files that are
# part of the delivery (the reports, .env.example, the new route/tests). It
# therefore contains exactly the tracked tree — no node_modules, no .next, no
# database, no .env, no caches, no logs, no workspaces.
#
# Usage: tools/build-release.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
STAMP=$(date -u +%Y%m%d)
NAME="agentscope-suite-jarvis-v2.1-repaired-$STAMP"
OUT="$ROOT/release"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT"
mkdir -p "$STAGE/$NAME"

# 1) every tracked file
git ls-files -z | while IFS= read -r -d '' f; do
  [ -e "$f" ] || continue
  # never ship database content: `npm run setup` recreates the schema. The
  # tracked prisma/db/custom.db is an empty placeholder; a real one would leak
  # the user's tasks, conversations and audit trail.
  case "$f" in
    *.db|*.sqlite|*.sqlite3|*/db/.secret-key|*/db/.desktop-token) continue ;;
  esac
  mkdir -p "$STAGE/$NAME/$(dirname "$f")"
  cp -p "$f" "$STAGE/$NAME/$f"
done

# 2) the deliverable files that are not committed yet
for f in BUG_AUDIT_REPORT.md FIX_REPORT.md TEST_RESULTS.md SECURITY_REPORT.md FEATURE_STATUS.md \
         README.md studio/.env.example \
         'studio/src/app/api/providers/[id]/test/route.ts' \
         studio/src/lib/agentic/retention.ts \
         studio/tests/audit-2026-10-regressions.test.ts; do
  if [ -e "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    mkdir -p "$STAGE/$NAME/$(dirname "$f")"
    cp -p "$f" "$STAGE/$NAME/$f"
  fi
done

# 3) refuse to ship anything that looks like a secret or a build artefact
FORBIDDEN=(
  '.env' '.next' 'node_modules' '.agentic-workspace' 'dev.log'
  '.secret-key' '.desktop-token'
)
for f in "${FORBIDDEN[@]}"; do
  if find "$STAGE/$NAME" -name "$f" -print -quit | grep -q .; then
    echo "REFUSING: '$f' would be included in the archive" >&2
    find "$STAGE/$NAME" -name "$f" >&2
    exit 1
  fi
done
# Deliberate test fixtures DO contain key-shaped strings (they exist to prove
# the masking works), so only non-test, non-documentation files are checked for
# a real-looking credential.
SECRET_RE='sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
HITS=$(grep -rIlE "$SECRET_RE" "$STAGE/$NAME" 2>/dev/null \
  | grep -vE '/(tests|docs)/|/node_modules/|\.md$' || true)
if [ -n "$HITS" ]; then
  echo "REFUSING: a credential-shaped string was found in a source file:" >&2
  echo "$HITS" >&2
  exit 1
fi
# and no live .env may exist anywhere in the tree
if find "$STAGE/$NAME" -name '.env' -print -quit | grep -q .; then
  echo "REFUSING: a .env file would be included" >&2
  exit 1
fi

# 4) archive + checksums
ARCHIVE="$OUT/$NAME.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > SHA256SUMS.txt )
git ls-files > "$OUT/TREE-$NAME.txt"

echo "built: $ARCHIVE"
echo "size : $(du -h "$ARCHIVE" | cut -f1)"
echo "files: $(tar -tzf "$ARCHIVE" | wc -l)"
echo "sha256: $(cut -d' ' -f1 "$OUT/SHA256SUMS.txt")"
