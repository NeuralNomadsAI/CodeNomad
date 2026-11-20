# Shared layout for the CodeNomad Rust user service. Sourced, never run.
set -euo pipefail
umask 077
CNRS_HOME=${CNRS_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/codenomad-rs}
CNRS_CONFIG=${CNRS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/codenomad-rs}
CNRS_STATE=${CNRS_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/codenomad-rs}
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
# Distinct names let a second installation (other roots) run beside the default one.
RUST_UNIT=${CNRS_RUST_UNIT:-codenomad-rs.service}
DAEMON_UNIT=${CNRS_DAEMON_UNIT:-codenomad-opencode.service}
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

# Release trust root: the verifier installed by install.sh and the trust state
# (pinned key, highest accepted serial, accepted releases), kept in config with a
# copy in state; the copy with the higher serial wins.
VERIFIER=$CNRS_HOME/bin/cnrs-release
TRUST=$CNRS_CONFIG/release-trust
TRUST_COPY=$CNRS_STATE/release-trust

# trust <admit|commit|staged> <release>: prints the version.
trust() {
  local command=$1 dir=$2 out
  [ -x "$VERIFIER" ] || die "release verifier missing: run install.sh"
  if [ "$command" = staged ]; then out=$("$VERIFIER" staged "$dir" "$TRUST" "$TRUST_COPY") || die "release refused: $dir"
  else out=$("$VERIFIER" "$command" "$dir" "$TRUST" "$TRUST_COPY" "$CNRS_HOME/releases") || die "release refused: $dir"; fi
  [[ $out =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$ ]] || die "invalid version: $out"
  printf '%s' "$out"
}
# Signature by the pinned key, every file listed and matching, serial above the
# highest accepted one (or the very release that set it).
verify_release() { trust admit "$1"; }

# Copy a release beside the others, verify the copy itself before it can run,
# then commit it: serial and announced next key advance in one atomic write of
# each trust copy. An existing copy must be identical; it is committed again
# (an install interrupted before its commit completes).
stage_release() {
  local dir=$1 version; version=$(verify_release "$dir")
  local dest=$CNRS_HOME/releases/$version
  mkdir -p "$CNRS_HOME/releases"
  if [ -d "$dest" ]; then
    cmp -s "$dir/SHA256SUMS" "$dest/SHA256SUMS" || die "release $version already installed with other contents"
  else
    rm -rf "$dest.tmp"
    cp -a "$dir" "$dest.tmp"
    chmod -R go-rwx "$dest.tmp"
    [ "$(verify_release "$dest.tmp")" = "$version" ] || die "staged copy of $version differs"
    mv -T "$dest.tmp" "$dest"
    log "staged release $version"
  fi
  [ "$(trust commit "$dest")" = "$version" ] || die "commit of $version failed"
  printf '%s' "$version"
}
# Atomic symlink swap: link <name> -> releases/<version>.
point() {
  ln -sfn "releases/$2" "$CNRS_HOME/.$1.tmp"
  mv -T "$CNRS_HOME/.$1.tmp" "$CNRS_HOME/$1"
}
linked_version() { local t; t=$(readlink "$CNRS_HOME/$1" 2>/dev/null) || return 1; basename "$t"; }

conf() { sed -n "s/^$1=//p" "$CNRS_CONFIG/install.conf" | tail -1; }

restart_and_check() {
  # A crash-looping release may have hit the start limit.
  systemctl --user reset-failed "$RUST_UNIT" 2>/dev/null || true
  systemctl --user restart "$RUST_UNIT"
  bash "$(dirname "${BASH_SOURCE[0]}")/health.sh"
}
