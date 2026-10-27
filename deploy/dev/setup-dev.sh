#!/bin/bash
# The dev copy of co-note at https://conote-dev.sniggles.de, from this checkout
# (any branch or worktree): its own note server (conote-dev-sync, port 5184,
# data in /var/lib/conote-dev - no production notes or accounts) and web root.
# Run: sudo bash deploy/dev/setup-dev.sh   (first time, and after server changes)
# Client-only changes: bash deploy/dev/publish-dev.sh (no sudo).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
REPO=$(cd "$(dirname "$0")/../.." && pwd)
CADDY=/etc/caddy/Caddyfile
OUT=$REPO/deploy/dist

id conote &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin conote
install -d -o marco -g marco -m 755 /srv/conote-dev-web

# Our site block, replaced (or added) like setup-server.sh does; restored if Caddy rejects it.
BACKUP="$CADDY.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$CADDY" "$BACKUP"
awk '/^# co-note dev at conote-dev\.sniggles\.de|^conote-dev\.sniggles\.de \{/ {skip=1} !skip {print} skip && /^\}/ {skip=0}' "$BACKUP" \
  | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$CADDY"
{ echo; cat "$REPO/deploy/dev/Caddyfile"; } >> "$CADDY"
if ! caddy validate --config "$CADDY" --adapter caddyfile; then
  cp -a "$BACKUP" "$CADDY"
  echo "Caddy rejected the new config - restored $BACKUP"; exit 1
fi
systemctl reload caddy
echo "conote-dev.sniggles.de block in $CADDY updated (backup: $BACKUP)"

# The note server, bundled as marco (root never runs anything from node_modules).
sudo -u marco "$REPO/node_modules/.bin/esbuild" "$REPO/server/sync-server.js" \
  --bundle --platform=node --format=cjs --target=node20 \
  --external:bufferutil --external:utf-8-validate \
  --outfile="$OUT/sync-dev.cjs" --log-level=warning
install -d -m 755 /opt/conote-dev
install -m 644 "$OUT/sync-dev.cjs" /opt/conote-dev/sync.cjs
install -m 644 "$REPO/deploy/dev/conote-dev-sync.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet conote-dev-sync
systemctl restart conote-dev-sync
sleep 1
systemctl --no-pager --lines=3 status conote-dev-sync | grep -E "●|Active|listening"

sudo -u marco bash "$REPO/deploy/dev/publish-dev.sh"
