#!/usr/bin/env bash
# Ship PinkySwear to Cloudflare Pages (project `pinkyswear`, asdfghjk.lol account).
# Stages only the app shell into a scratch dir, so session files (.claude/handoff*.md),
# server.js, tests and docs never reach the public URL (server.js runs only inside the
# bundled Functions; its bindings are set on the Pages project, see deploy/README.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The Cloudflare account that owns the asdfghjk.lol zone; kept out of this public repo.
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID to the asdfghjk.lol account}"
PROJECT=pinkyswear
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

APP_FILES=(index.html styles.css app.js core.js db.js offlineSync.js populateTemplates.js
  templateSchema.js templateThumbnails.js service-worker.js manifest.json icon.svg)
for f in "${APP_FILES[@]}"; do cp "$ROOT/$f" "$STAGE/"; done
cp "$ROOT/deploy/_headers" "$ROOT/deploy/404.html" "$STAGE/"

echo "staged: $(ls "$STAGE" | tr '\n' ' ')"
[[ "${1:-}" == "--stage-only" ]] && { cp -R "$STAGE/." "${2:?--stage-only needs a dir}"; exit 0; }

# Run from the repo root: wrangler bundles ./functions (the /api backend, which imports
# server.js) from the working directory, so the backend ships without being served as a file.
cd "$ROOT"
CLOUDFLARE_ACCOUNT_ID=$ACCOUNT NODE_OPTIONS=--dns-result-order=ipv4first \
  "${WRANGLER:-wrangler}" pages deploy "$STAGE" --project-name "$PROJECT" --branch main \
  --commit-hash "$(git -C "$ROOT" rev-parse HEAD)" --commit-dirty=true
