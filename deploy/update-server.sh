#!/bin/bash
# Bundle the note server and (re)deploy it to /opt/conote, with its backup job.
# Run: sudo bash deploy/update-server.sh   (after any change in server/ or deploy/*.service|timer|backup.sh)
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$REPO/deploy/dist

# One dependency-free file, built as marco so root never runs anything from
# node_modules. ws's native speedups are optional; leave them out.
sudo -u marco "$REPO/node_modules/.bin/esbuild" "$REPO/server/sync-server.js" \
  --bundle --platform=node --format=cjs --target=node20 \
  --external:bufferutil --external:utf-8-validate \
  --outfile="$OUT/sync.cjs" --log-level=warning

# The old open matchmaking server (v1 broadcast) is gone: matchmaking now lives
# in conote-sync behind note tokens. Retire it if this host still runs it.
if [[ -f /etc/systemd/system/conote-signal.service ]]; then
  systemctl disable --now conote-signal 2>/dev/null || true
  rm -f /etc/systemd/system/conote-signal.service /opt/conote/signal.cjs
  echo "retired conote-signal"
fi

install -d -m 755 /opt/conote
install -m 644 "$OUT/sync.cjs" /opt/conote/
# Root-owned copy: the timer runs it as root, so it must not be editable from the repo.
install -m 755 -o root -g root "$REPO/deploy/backup.sh" /opt/conote/backup.sh
install -m 644 "$REPO/deploy/conote-sync.service" "$REPO/deploy/conote-backup.service" \
  "$REPO/deploy/conote-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet conote-sync
systemctl enable --quiet --now conote-backup.timer
systemctl restart conote-sync
sleep 1
systemctl --no-pager --lines=3 status conote-sync | grep -E "●|Active|listening"
systemctl --no-pager list-timers conote-backup.timer | sed -n 1,2p
