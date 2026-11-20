#!/usr/bin/env bash
# uninstall.sh [--purge]: stop and remove the user units. Releases, secrets,
# identity, devices and the daemon profile stay unless --purge is given.
source "$(dirname "$0")/common.sh"
systemctl --user disable --now "$RUST_UNIT" "$DAEMON_UNIT" >/dev/null 2>&1 || true
rm -f "$UNIT_DIR/$RUST_UNIT" "$UNIT_DIR/$DAEMON_UNIT"
systemctl --user daemon-reload
systemctl --user reset-failed "$RUST_UNIT" "$DAEMON_UNIT" 2>/dev/null || true
if [ "${1:-}" = --purge ]; then
  rm -rf "$CNRS_HOME" "$CNRS_CONFIG" "$CNRS_STATE"
  log "purged"
fi
log "uninstalled"
