#!/usr/bin/env bash
# package.sh <version> <codenomad-rs binary> <plugins folder> <output parent> <cnrs-release> <release.key> <serial> [next release.pub]
# Builds <output parent>/codenomad-rs-<version>/: the binary (its --version must
# be <version>), the bundled plugins (session-pruning, automation, missions +
# provider, memory), VERSION, MANIFEST (serial, announced next key), SHA256SUMS
# and SHA256SUMS.minisig.
source "$(dirname "$0")/common.sh"
[ $# -eq 7 ] || [ $# -eq 8 ] || die "usage: package.sh <version> <binary> <plugins> <output-parent> <cnrs-release> <release.key> <serial> [next.pub]"
version=$1 binary=$2 plugins=$3 parent=$4 tool=$5 key=$6 serial=$7 next=${8:-}
built=$("$binary" --version) || die "binary does not report a version"
[ "$built" = "$version" ] || die "binary version $built differs from release version $version"
out=$parent/codenomad-rs-$version
rm -rf "$out.tmp"
mkdir -p "$out.tmp/plugins"
install -m 0755 "$binary" "$out.tmp/codenomad-rs"
for feature in session-pruning automation missions memory; do
  install -d -m 0755 "$out.tmp/plugins/$feature"
  install -m 0644 "$plugins/$feature/plugin.mjs" "$out.tmp/plugins/$feature/plugin.mjs"
done
install -m 0644 "$plugins/missions/provider.mjs" "$out.tmp/plugins/missions/provider.mjs"
printf '%s\n' "$version" > "$out.tmp/VERSION"
"$tool" manifest "$out.tmp" "$serial" ${next:+"$next"} >/dev/null || die "invalid serial or next key"
chmod 0644 "$out.tmp/MANIFEST"
(cd "$out.tmp" && find . -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)
"$tool" sign "$out.tmp" "$key" >/dev/null || die "signing failed"
if [ -d "$out" ]; then
  cmp -s "$out.tmp/SHA256SUMS" "$out/SHA256SUMS" || die "$out exists with other contents"
  rm -rf "$out.tmp"
else
  mv -T "$out.tmp" "$out"
fi
printf '%s\n' "$out"
