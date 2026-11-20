#!/usr/bin/env bash
# health.sh [timeout seconds, default 45]
# The running service must be the binary of releases/<current>, answer an
# authenticated /api/meta with the persisted serverId and report its bundled
# plugins provisioned by this very process. Prints one JSON line; exit 1 otherwise.
source "$(dirname "$0")/common.sh"
deadline=$(( $(date +%s) + ${1:-45} ))
port=$(conf PORT)
password=$(sed -n 's/^CNRS_SERVER_PASSWORD=//p' "$CNRS_CONFIG/codenomad-rs.env")
expected=$(readlink -f "$CNRS_HOME/current")/codenomad-rs
jar=$(mktemp); trap 'rm -f "$jar"' EXIT
reason=starting
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 1
  pid=$(systemctl --user show -p MainPID --value "$RUST_UNIT")
  [ "${pid:-0}" != 0 ] || { reason="service not running"; continue; }
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
  [ "$exe" = "$expected" ] || { reason="running binary is not the current release"; continue; }
  jq -cn --arg username codenomad --arg password "$password" '{$username,$password}' |
    curl -fsS -o /dev/null -c "$jar" -H 'content-type: application/json' --data @- \
      "http://127.0.0.1:$port/api/auth/login" 2>/dev/null || { reason="login refused"; continue; }
  meta=$(curl -fsS -b "$jar" "http://127.0.0.1:$port/api/meta" 2>/dev/null) || { reason="meta unavailable"; continue; }
  [ "$(jq -r .serverVersion <<<"$meta")" = "$(cat "$CNRS_HOME/current/VERSION")" ] || { reason="serverVersion differs from the current release VERSION"; continue; }
  server=$(jq -r .serverId <<<"$meta")
  [ "$server" = "$(jq -r .serverId "$CNRS_STATE/host.json")" ] || { reason="serverId differs from host.json"; continue; }
  status=$CNRS_STATE/host.data/plugin-provision.json
  [ -f "$status" ] && jq -e --argjson pid "$pid" '.state=="provisioned" and .pid==$pid and (.features|length)==.expected' "$status" >/dev/null \
    || { reason="bundled plugins not provisioned"; continue; }
  jq -cn --arg version "$(linked_version current)" --arg serverVersion "$(jq -r .serverVersion <<<"$meta")" --arg serverId "$server" --argjson pid "$pid" \
    --argjson plugins "$(jq -c '[.features[]|{feature,sha256,provider,ready}]' "$status")" --argjson connections "$(jq .connections "$status")" \
    --arg remoteUrl "$(jq -r '.remoteUrl // ""' <<<"$meta")" --arg tlsFingerprint "$(jq -r '.tlsFingerprint // ""' <<<"$meta")" \
    '{healthy:true,$version,$serverVersion,$serverId,$pid,$remoteUrl,$tlsFingerprint,$connections,$plugins}'
  exit 0
done
jq -cn --arg reason "$reason" --arg version "$(linked_version current || echo none)" '{healthy:false,$version,$reason}'
exit 1
