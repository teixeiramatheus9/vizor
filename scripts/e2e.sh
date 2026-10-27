#!/usr/bin/env bash
# The end-to-end run, in a nested X server whose window shrinks to 1x1 at once:
# nothing shows up over the desktop (Electron 42 has no working headless).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d test/e2e/node_modules/playwright-core ] || npm --prefix test/e2e install --no-audit --no-fund >/dev/null
command -v Xephyr >/dev/null || { echo "e2e: needs Xephyr (apt install xserver-xephyr)"; exit 1; }
display=":$((90 + RANDOM % 9))"
Xephyr "$display" -screen 1400x900 -no-host-grab -title "vizor-e2e$display" >/dev/null 2>&1 &
xephyr=$!
trap 'kill $xephyr 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  window=$(xdotool search --name "vizor-e2e$display" 2>/dev/null | head -1 || true)
  [ -n "$window" ] && { xdotool windowsize "$window" 1 1 windowmove "$window" 0 0; break; }
  sleep 0.05
done
DISPLAY="$display" node test/e2e/flow.e2e.mjs
DISPLAY="$display" node test/e2e/review.e2e.mjs
DISPLAY="$display" node test/e2e/tabs.e2e.mjs
DISPLAY="$display" node test/e2e/perf.e2e.mjs
