#!/usr/bin/env bash
# Answer only the fixture process's origin-labelled native dialog on its display.
set -eu
answer=$1
pid=$2
output=$3
case "$answer" in stay|leave) ;; *) exit 2;; esac
[[ "$pid" =~ ^[0-9]+$ ]] && [[ "$output" = /* ]] && test -n "${DISPLAY:-}"
window=$(timeout 10s xdotool search --all --sync --onlyvisible --pid "$pid" --name '^http://127\.0\.0\.1:18741/' | head -n 1)
while IFS='=' read -r key value; do
  case "$key" in X|Y|WIDTH|HEIGHT)
    [[ "$value" =~ ^-?[0-9]+$ ]] || exit 2
    printf -v "$key" '%s' "$value";;
  esac
done < <(xdotool getwindowgeometry --shell "$window")
import -window "$window" "$output"
x=$((WIDTH / 4))
test "$answer" = stay || x=$((WIDTH * 3 / 4))
xdotool windowfocus "$window" mousemove --sync --window "$window" "$x" "$((HEIGHT - 23))" click 1
