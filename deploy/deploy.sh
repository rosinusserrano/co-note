#!/bin/bash
# Deploy everything: the note server, then the web app. Server first: a new
# client may call endpoints only the new server has.
# Run: bash deploy/deploy.sh   (asks for the sudo password for the server part)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)

if [[ $EUID -eq 0 ]]; then
  bash "$REPO/deploy/update-server.sh"
  sudo -u marco bash "$REPO/deploy/publish-web.sh"
else
  sudo bash "$REPO/deploy/update-server.sh"
  bash "$REPO/deploy/publish-web.sh"
fi

# The live server answers, and it's the new one (accounts exist: 401, not 404).
curl -fsS https://conote.sniggles.de/api/health >/dev/null && echo "health: ok"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST https://conote.sniggles.de/api/account/notes)
[[ $code == 401 ]] && echo "server: current" || echo "server: unexpected answer ($code) - check: systemctl status conote-sync"
