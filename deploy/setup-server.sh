#!/bin/bash
# One-time setup of co-note on this VPS at https://conote.sniggles.de.
# Run: sudo bash deploy/setup-server.sh      (safe to re-run)
#
#  1. system user `conote` for the note server
#  2. /srv/conote-web owned by marco, so publish-web.sh needs no sudo
#  3. puts deploy/Caddyfile into /etc/caddy/Caddyfile (replacing an older copy;
#     backup first, restored if Caddy rejects it), reloads
#  4. update-server.sh: bundles + installs + starts conote-sync and the daily
#     backup timer (and retires the old conote-signal service if present)
#  5. publish-web.sh: builds the app into /srv/conote-web
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
CADDY=/etc/caddy/Caddyfile

id conote &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin conote
install -d -o marco -g marco -m 755 /srv/conote-web

# Replace our site block (from its header comment to the next top-level `}`) with
# the repo's version, leaving every other site untouched. Restore on failure.
BACKUP="$CADDY.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$CADDY" "$BACKUP"
awk '/^# co-note at conote\.sniggles\.de|^conote\.sniggles\.de \{/ {skip=1} !skip {print} skip && /^\}/ {skip=0}' "$BACKUP" \
  | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$CADDY"
{ echo; cat "$REPO/deploy/Caddyfile"; } >> "$CADDY"
if ! caddy validate --config "$CADDY" --adapter caddyfile; then
  cp -a "$BACKUP" "$CADDY"
  echo "Caddy rejected the new config - restored $BACKUP"; exit 1
fi
systemctl reload caddy
echo "conote.sniggles.de block in $CADDY updated (backup: $BACKUP)"

bash "$REPO/deploy/update-server.sh"
sudo -u marco bash "$REPO/deploy/publish-web.sh"

echo
echo "--- check"
curl -s -o /dev/null -w "page: %{http_code}\n" https://conote.sniggles.de/
