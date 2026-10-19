#!/bin/bash
# Snapshot co-note's state (registry, token secret, drawings) into a dated
# tarball and keep the newest $KEEP. Installed to /opt/conote/backup.sh and run
# daily by conote-backup.timer; run it by hand any time:
#   sudo /opt/conote/backup.sh
#
# Consistent enough without stopping the server: every file in the state dir is
# replaced by rename, so each file in the archive is whole. At worst a note
# created mid-backup has its registry entry without its drawing (or the reverse).
#
# Restore:
#   sudo systemctl stop conote-sync
#   sudo tar -xzf /var/backups/conote/conote-<stamp>.tar.gz -C /var/lib/conote
#   sudo chown -R conote:conote /var/lib/conote
#   sudo systemctl start conote-sync
#
# These stay on this machine. For a copy that survives losing the VPS, pull
# /var/backups/conote from elsewhere (rsync/scp) — the tarballs hold the token
# secret and passcode hashes, so keep that copy private.
set -euo pipefail
SRC=${CONOTE_DATA:-/var/lib/conote}
DEST=${CONOTE_BACKUPS:-/var/backups/conote}
KEEP=${CONOTE_BACKUP_KEEP:-14}

[[ -d $SRC ]] || { echo "nothing to back up: $SRC missing"; exit 0; }
umask 077
install -d -m 700 "$DEST"
stamp=$(date +%Y%m%d-%H%M%S)
tmp="$DEST/.conote-$stamp.tar.gz.part"
# Skip half-written files (*.tmp); they are replaced by rename once complete.
tar -czf "$tmp" -C "$SRC" --exclude='*.tmp' .
mv "$tmp" "$DEST/conote-$stamp.tar.gz"

# Keep the newest $KEEP.
ls -1t "$DEST"/conote-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backed up $SRC to $DEST/conote-$stamp.tar.gz ($(ls -1 "$DEST"/conote-*.tar.gz | wc -l) kept)"
