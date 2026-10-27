#!/bin/bash
# Build the app and publish it to https://conote.sniggles.de (CONOTE_WEB: another
# web root, e.g. the dev site - deploy/dev/publish-dev.sh). No sudo needed
# (/srv/conote-web is owned by marco). Run after any client change.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WEB=${CONOTE_WEB:-/srv/conote-web}
[[ -d $WEB && -w $WEB ]] || { echo "$WEB missing or not writable - run: sudo bash $REPO/deploy/setup-server.sh (dev: deploy/dev/setup-dev.sh)"; exit 1; }
cd "$REPO"
npm run build
# Old hashed bundles stay for a while: an app still running the previous
# version may load one lazily (pdf.js, export) before it reloads into the new.
rsync -a --delete --exclude '/_app/immutable/' build/ "$WEB/"
rsync -a build/_app/immutable/ "$WEB/_app/immutable/"
find "$WEB/_app/immutable" -type f -mtime +30 -delete
echo "published to $WEB"
