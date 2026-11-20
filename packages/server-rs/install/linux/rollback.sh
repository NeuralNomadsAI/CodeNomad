#!/usr/bin/env bash
# rollback.sh: swap `current` and `previous`, restart the backend, check health.
source "$(dirname "$0")/common.sh"
running=$(linked_version current) || die "not installed"
target=$(linked_version previous) || die "no previous release to roll back to"
[ -x "$CNRS_HOME/releases/$target/codenomad-rs" ] || die "previous release $target is missing"
# A staged release could have been altered since: it must be one accepted here,
# unchanged. The serial counter only gates new releases: it stays where it is.
[ "$(trust staged "$CNRS_HOME/releases/$target")" = "$target" ] || die "previous release $target does not verify"
point current "$target"
point previous "$running"
log "rolling back $running -> $target"
restart_and_check
