#!/usr/bin/env bash
# admin.sh <METHOD> <path> [json body]: authenticated loopback administration
# request to the installed backend. Prints the HTTP status, then the body.
source "$(dirname "$0")/common.sh"
[ $# -ge 2 ] || die "usage: admin.sh <METHOD> <path> [json]"
port=$(conf PORT)
password=$(sed -n 's/^CNRS_SERVER_PASSWORD=//p' "$CNRS_CONFIG/codenomad-rs.env")
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
jq -cn --arg username codenomad --arg password "$password" '{$username,$password}' |
  curl -fsS -o /dev/null -c "$work/jar" -H 'content-type: application/json' --data @- "http://127.0.0.1:$port/api/auth/login"
args=(-sS -o "$work/body" -w '%{http_code}\n' -X "$1" -b "$work/jar" -H 'content-type: application/json')
[ $# -lt 3 ] || args+=(--data "$3")
curl "${args[@]}" "http://127.0.0.1:$port$2"
cat "$work/body"; echo
