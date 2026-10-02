#!/usr/bin/env bash
# Build the committed HEAD in a clean worktree and publish dist/index.html to the gh-pages branch.
# Usage: GITHUB_TOKEN_FILE=/path/to/token bash web/scripts/deploy_pages.sh
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
TMP=$(mktemp -d)
git -C "$ROOT" worktree add -q "$TMP/src" HEAD
cp -r "$ROOT/web/node_modules" "$TMP/src/web/" 2>/dev/null || (cd "$TMP/src/web" && npm ci)
(cd "$TMP/src/web" && npm run build >/dev/null)
mkdir -p "$TMP/site" && cp "$TMP/src/web/dist/index.html" "$TMP/site/" && touch "$TMP/site/.nojekyll"
REV=$(git -C "$ROOT" rev-parse --short HEAD)
(cd "$TMP/site" && git init -q -b gh-pages && git add -A && git commit -qm "Deploy Burgmap site ($REV)")
T=$(tr -d ' \r\n' < "${GITHUB_TOKEN_FILE:?set GITHUB_TOKEN_FILE}")
B=$(printf 'x-access-token:%s' "$T" | base64 -w0)
git -C "$TMP/site" -c http.extraheader="Authorization: Basic $B" push -q -f https://github.com/dunkean/burgmap.git gh-pages
git -C "$ROOT" worktree remove --force "$TMP/src"
echo "Deployed $REV to https://dunkean.github.io/burgmap/"
