#!/bin/bash
# Build the app and publish it to https://conote.sniggles.de. No sudo needed
# (/srv/conote-web is owned by marco). Run after any client change.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
WEB=/srv/conote-web
[[ -d $WEB && -w $WEB ]] || { echo "$WEB missing or not writable - run: sudo bash $REPO/deploy/setup-server.sh"; exit 1; }
cd "$REPO"
npm run build
rsync -a --delete build/ "$WEB/"
echo "published to $WEB"
