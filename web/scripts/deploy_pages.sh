#!/usr/bin/env bash
# Build committed HEAD in a clean worktree and publish the app to gh-pages.
# Uses Git credentials by default; optionally set GITHUB_TOKEN_FILE=/path/to/token.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
REMOTE=$(git -C "$ROOT" remote get-url origin)
TMP=$(mktemp -d)
git -C "$ROOT" worktree add -q "$TMP/src" HEAD
cp -r "$ROOT/web/node_modules" "$TMP/src/web/" 2>/dev/null || (cd "$TMP/src/web" && npm ci)
(cd "$TMP/src/web" && npm run build >/dev/null)
mkdir -p "$TMP/site"
cp "$TMP/src/web/dist/index.html" "$TMP/src/web/dist/testbench.html" "$TMP/site/"
touch "$TMP/site/.nojekyll"
REV=$(git -C "$ROOT" rev-parse --short HEAD)
FULL_REV=$(git -C "$ROOT" rev-parse HEAD)
printf '{"revision":"%s"}\n' "$FULL_REV" > "$TMP/site/version.json"
(cd "$TMP/site" && git init -q -b gh-pages && git add -A && git commit -qm "Deploy Magna Urbis site ($REV)")
if [[ -n "${GITHUB_TOKEN_FILE:-}" ]]; then
  T=$(tr -d ' \r\n' < "$GITHUB_TOKEN_FILE")
  B=$(printf 'x-access-token:%s' "$T" | base64 -w0)
  git -C "$TMP/site" -c http.extraheader="Authorization: Basic $B" push -q -f "$REMOTE" gh-pages
else
  git -C "$TMP/site" push -q -f "$REMOTE" gh-pages
fi
git -C "$ROOT" worktree remove --force "$TMP/src"
echo "Deployed $REV to the gh-pages branch of $REMOTE"
