#!/bin/bash
# Build this checkout and publish it to https://conote-dev.sniggles.de (no sudo).
# The server side: sudo bash deploy/dev/setup-dev.sh
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
CONOTE_WEB=/srv/conote-dev-web CONOTE_APP_NAME="conote dev" bash "$REPO/deploy/publish-web.sh"
curl -fsS https://conote-dev.sniggles.de/api/health >/dev/null && echo "dev health: ok" || echo "dev server not answering - check: systemctl status conote-dev-sync"
