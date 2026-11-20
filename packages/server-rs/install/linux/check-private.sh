#!/usr/bin/env bash
# check-private.sh <CNRS_HOME> <CNRS_CONFIG> <CNRS_STATE>
# Same guarantee as the Windows ACL check (audit E1), run by systemd before each
# backend start (ExecStartPre) and by the qualification: what the service
# executes (bin, the current release, the pinned OpenCode) belongs to this user,
# holds no link and no group/other write bit; the secret folders allow nothing
# to group or other. Prints each problem; exit 1 when there is one.
set -uo pipefail
[ $# -eq 3 ] || { echo "usage: check-private.sh <home> <config> <state>" >&2; exit 2; }
home=$1 config=$2 state=$3 uid=$(id -u) problems=0
report() { while IFS= read -r line; do [ -n "$line" ] && { echo "not private: $line"; problems=1; }; done; }
for dir in "$home" "$config" "$state"; do
  [ -d "$dir" ] && [ ! -L "$dir" ] || { echo "not private: $dir is missing or a link"; problems=1; continue; }
  report < <(find -P "$dir" -maxdepth 0 \( ! -user "$uid" -o -perm /077 \) -print)
done
for link in "$home/current" "$home/opencode/current"; do
  target=$(readlink -f "$link") || { echo "not private: $link is unresolvable"; problems=1; continue; }
  case $target in "$home"/*) ;; *) echo "not private: $link leaves $home"; problems=1; continue ;; esac
  report < <(find -P "$target" \( -type l -o ! -user "$uid" -o -perm /022 \) -print)
done
report < <(find -P "$home/bin" \( -type l -o ! -user "$uid" -o -perm /022 \) -print)
report < <(find -P "$config" \( -type l -o ! -user "$uid" -o -perm /077 \) -print)
exit $problems
