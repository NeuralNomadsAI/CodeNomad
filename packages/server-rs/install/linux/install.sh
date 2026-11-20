#!/usr/bin/env bash
# install.sh <release folder> --public-key <release.pub> --verifier <cnrs-release>
#   [--port N] [--daemon-port N] [--plugins 1|<list>] [--https-bind IP:PORT --https-name NAME] [--test-markers DIR]
# Idempotent first install of the user services. A later release goes through
# update.sh; running install.sh again only rewrites identical units and keeps
# secrets, identity, devices and the current release. The public key and the
# verifier are pinned on the first install; every release must verify against
# the pinned key and carry a serial above the highest one accepted.
source "$(dirname "$0")/common.sh"
here=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 1 ] || die "usage: install.sh <release> --public-key <pub> --verifier <cnrs-release> [options]"
release=$1; shift
port='' daemon_port='' plugins='' bind='' name='' markers='' key='' verifier=''
while [ $# -gt 0 ]; do
  case $1 in
    --port) port=$2; shift 2 ;;
    --daemon-port) daemon_port=$2; shift 2 ;;
    --plugins) plugins=$2; shift 2 ;;
    --public-key) key=$2; shift 2 ;;
    --verifier) verifier=$2; shift 2 ;;
    --https-bind) bind=$2; shift 2 ;;
    --https-name) name=$2; shift 2 ;;
    --test-markers) markers=$2; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[ -x "$CNRS_HOME/opencode/current/bin/opencode" ] || die "run install-opencode.sh first"
command -v curl >/dev/null && command -v jq >/dev/null || die "curl and jq are required"
mkdir -p "$CNRS_CONFIG" "$CNRS_STATE" "$CNRS_HOME/bin"
chmod 700 "$CNRS_CONFIG" "$CNRS_STATE"
if [ ! -f "$TRUST" ] && [ ! -f "$TRUST_COPY" ]; then
  [ -n "$key" ] && [ -x "$verifier" ] || die "first install needs --public-key and --verifier"
  install -m 0700 "$verifier" "$VERIFIER"
fi
if [ -n "$key" ]; then
  # First install: pins the key at serial 0. Later: the key must be the pinned one
  # (after a rotation, the announced key); refused when releases are staged
  # without a trust state (restore it or --purge).
  pinned=$("$VERIFIER" pin "$key" "$TRUST" "$TRUST_COPY" "$CNRS_HOME/releases") || die "release key refused"
  [ -z "$pinned" ] || log "$pinned"
fi
version=$(stage_release "$release")
# Launch check run by systemd before each start (audit E1).
cmp -s "$here/check-private.sh" "$CNRS_HOME/bin/check-private.sh" 2>/dev/null || install -m 0700 "$here/check-private.sh" "$CNRS_HOME/bin/check-private.sh"
fingerprint() { { cat "$CNRS_CONFIG"/*.env "$CNRS_CONFIG/install.conf" "$UNIT_DIR/$DAEMON_UNIT" "$UNIT_DIR/$RUST_UNIT" 2>/dev/null || true; } | sha256sum; }
before=$(fingerprint)
mkdir -p "$CNRS_CONFIG" "$CNRS_STATE/projects" "$CNRS_STATE/opencode" "$UNIT_DIR"
chmod 700 "$CNRS_CONFIG" "$CNRS_STATE" "$CNRS_STATE/opencode"

set_key() { # set_key <file> <KEY> <value>: replace or append, file stays 0600
  local file=$1 key=$2 value=$3
  touch "$file"; chmod 600 "$file"
  if grep -q "^$key=" "$file"; then
    local escaped; escaped=$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')
    sed -i "s|^$key=.*|$key=$escaped|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
secret() { head -c 32 /dev/urandom | base64 | tr -d '/+=\n'; }

conf_file=$CNRS_CONFIG/install.conf
[ -n "$port" ] || port=$( [ -f "$conf_file" ] && conf PORT || true )
set_key "$conf_file" PORT "${port:-47900}"
[ -n "$daemon_port" ] || daemon_port=$(conf DAEMON_PORT)
set_key "$conf_file" DAEMON_PORT "${daemon_port:-47941}"
daemon_port=$(conf DAEMON_PORT)
port=$(conf PORT)

oc=$CNRS_STATE/opencode
daemon_env=$CNRS_CONFIG/opencode.env
for kv in "HOME=$oc" "TMPDIR=$oc/tmp" "XDG_DATA_HOME=$oc/data" "XDG_CONFIG_HOME=$oc/config" \
  "XDG_STATE_HOME=$oc/state" "XDG_CACHE_HOME=$oc/cache" "OPENCODE_DB=$oc/native.db" \
  OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_FFF=1 OPENCODE_CONFIG_PROJECT_DISABLE=1; do
  set_key "$daemon_env" "${kv%%=*}" "${kv#*=}"
done
grep -q '^OPENCODE_SERVER_PASSWORD=' "$daemon_env" || set_key "$daemon_env" OPENCODE_SERVER_PASSWORD "$(secret)"
[ -z "$markers" ] || { set_key "$daemon_env" CNRS_TEST_PLUGIN_MARKERS "$markers"; mkdir -p "$markers"; }
mkdir -p "$oc/tmp"

rust_env=$CNRS_CONFIG/codenomad-rs.env
grep -q '^CNRS_SERVER_PASSWORD=' "$rust_env" 2>/dev/null || set_key "$rust_env" CNRS_SERVER_PASSWORD "$(secret)"
set_key "$rust_env" CNRS_OPENCODE_SERVICE_FILE "$oc/state/opencode/service.json"
[ -n "$plugins" ] || plugins=$(sed -n "s/^CNRS_PROVISION_PLUGINS=//p" "$rust_env" 2>/dev/null || true)
set_key "$rust_env" CNRS_PROVISION_PLUGINS "${plugins:-1}"
set_key "$rust_env" CNRS_PLUGIN_PROFILE_ROOT "$oc"
if [ -n "$bind" ]; then
  [ -n "$name" ] || die "--https-bind needs --https-name"
  set_key "$rust_env" CNRS_HTTPS_BIND "$bind"
  set_key "$rust_env" CNRS_HTTPS_NAME "$name"
fi

write_unit() { # only rewritten when the content differs
  local file=$UNIT_DIR/$1 content=$2
  if [ ! -f "$file" ] || [ "$(cat "$file")" != "$content" ]; then
    printf '%s\n' "$content" > "$file.tmp"; chmod 644 "$file.tmp"; mv "$file.tmp" "$file"; log "wrote $1"
  fi
}
write_unit "$DAEMON_UNIT" "[Unit]
Description=OpenCode daemon for CodeNomad (isolated profile)

[Service]
Type=simple
EnvironmentFile=$daemon_env
WorkingDirectory=$oc
ExecStartPre=/bin/bash $CNRS_HOME/bin/check-private.sh $CNRS_HOME $CNRS_CONFIG $CNRS_STATE
ExecStart=$CNRS_HOME/opencode/current/bin/opencode serve --service --hostname 127.0.0.1 --port $daemon_port
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target"
write_unit "$RUST_UNIT" "[Unit]
Description=CodeNomad Rust backend
# Fixed daemon endpoint: the backend reconnects (and reprovisions) after a daemon restart.
Wants=$DAEMON_UNIT
After=$DAEMON_UNIT

[Service]
Type=simple
EnvironmentFile=$rust_env
# glibc: scrypt's 16 MiB login buffer would raise the dynamic mmap threshold and keep
# that memory in the heap; a fixed threshold returns it (48 MiB budget).
Environment=GLIBC_TUNABLES=glibc.malloc.mmap_threshold=131072
WorkingDirectory=$CNRS_STATE
ExecStartPre=/bin/bash $CNRS_HOME/bin/check-private.sh $CNRS_HOME $CNRS_CONFIG $CNRS_STATE
ExecStart=$CNRS_HOME/current/codenomad-rs $CNRS_STATE/projects $CNRS_STATE/host.json $port $CNRS_HOME/opencode/current/bin/opencode
TimeoutStopSec=15
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target"
systemctl --user daemon-reload

linked_version current >/dev/null || point current "$version"
systemctl --user enable "$DAEMON_UNIT" "$RUST_UNIT" >/dev/null 2>&1
if [ "$before" != "$(fingerprint)" ]; then
  log "configuration changed: restarting running services"
  systemctl --user try-restart "$DAEMON_UNIT" "$RUST_UNIT"
fi
systemctl --user start "$DAEMON_UNIT" "$RUST_UNIT"
bash "$here/health.sh"
