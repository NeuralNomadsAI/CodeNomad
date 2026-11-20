#!/usr/bin/env bash
# update.sh <release folder>
# Stages the release beside the others, keeps the running one as `previous`,
# switches `current`, restarts the backend (the OpenCode daemon keeps running)
# and rolls back automatically when the health check fails.
source "$(dirname "$0")/common.sh"
here=$(cd "$(dirname "$0")" && pwd)
[ $# -eq 1 ] || die "usage: update.sh <release>"
version=$(stage_release "$1")
running=$(linked_version current) || die "not installed: run install.sh"
if [ "$running" = "$version" ]; then
  log "release $version is already current"
  exec bash "$here/health.sh"
fi
prior=$(linked_version previous || true)
point previous "$running"
point current "$version"
log "updating $running -> $version"
if restart_and_check; then
  log "release $version healthy"
  exit 0
fi
log "release $version failed its health check: rolling back to $running"
journalctl --user -u "$RUST_UNIT" -n 20 --no-pager >&2 || true
# The failed release never becomes a rollback target.
point current "$running"
if [ -n "$prior" ]; then point previous "$prior"; else rm -f "$CNRS_HOME/previous"; fi
restart_and_check || die "rollback to $running is unhealthy too"
log "rolled back to $running"
exit 2
