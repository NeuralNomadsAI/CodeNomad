#!/usr/bin/env bash
# install-opencode.sh <@opencode/cli-linux-x64 tgz> <sha256 of the tgz>
# Extracts the native OpenCode CLI used by the isolated test daemon to
# $CNRS_HOME/opencode/<version>/ and points opencode/current at it. Idempotent.
source "$(dirname "$0")/common.sh"
[ $# -eq 2 ] || die "usage: install-opencode.sh <tgz> <sha256>"
tgz=$1 sum=$2
echo "$sum  $tgz" | sha256sum --quiet --strict -c - || die "OpenCode archive checksum mismatch"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$tgz" -C "$work" package/package.json package/bin
version=$(jq -r .version "$work/package/package.json")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "unexpected OpenCode package version"
dest=$CNRS_HOME/opencode/$version
if [ ! -x "$dest/bin/opencode" ]; then
  mkdir -p "$CNRS_HOME/opencode"
  rm -rf "$dest.tmp"
  mv "$work/package" "$dest.tmp"
  chmod -R go-w "$dest.tmp"
  mv -T "$dest.tmp" "$dest"
fi
"$dest/bin/opencode" --version >/dev/null
ln -sfn "$version" "$CNRS_HOME/opencode/.current.tmp"
mv -T "$CNRS_HOME/opencode/.current.tmp" "$CNRS_HOME/opencode/current"
log "OpenCode $version ready"
