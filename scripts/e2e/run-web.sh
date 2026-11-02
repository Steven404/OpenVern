#!/usr/bin/env bash
# End-to-end run in web dev mode (plan §8, S9.2): dev API server (fake provider) + Vite on 5173, driven by headless
# Chromium over CDP. Temp data dir, always cleaned up. Needs a Chromium: set E2E_CHROME, or install Playwright's
# (`npx playwright install chromium`), or have chromium / google-chrome on PATH.
#   scripts/e2e/run-web.sh            smoke test (A1–A18)
#   E2E_SHOTS=1 scripts/e2e/run-web.sh  also take the S9.3 screenshots (E2E_SKIP_SMOKE=1: only those)
#   E2E_KEEP=1 …                      keep the scratch dir (screenshots, logs)
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$E2E_ROOT"

find_chrome() {
  local c
  if [ -n "${E2E_CHROME:-}" ]; then echo "$E2E_CHROME"; return; fi
  for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  for c in chromium chromium-browser google-chrome google-chrome-stable; do
    command -v "$c" && return
  done
}
CHROME="$(find_chrome)"
if [ -z "$CHROME" ]; then echo "no Chromium found (set E2E_CHROME)" >&2; exit 2; fi
for p in 8787 5173; do
  if port_in_use "$p"; then echo "port $p is in use (stop your dev server first)" >&2; exit 2; fi
done

e2e_init
CDP="$(free_port)"
BASE="http://localhost:5173/"

start_api() {
  OPENVERN_FAKE_PROVIDER=1 OPENVERN_DATA_DIR="$DATA" start_bg api npx tsx --tsconfig tsconfig.node.json src/server/dev.ts
  API_PGID=$LAST_PGID
  wait_for "API server" 40 api_up
}

start_api || { cat "$OUT/api.log"; exit 1; }
start_bg vite npx vite --config vite.web.config.ts
wait_for "Vite" 40 curl -sf "$BASE" || { cat "$OUT/vite.log"; exit 1; }
start_bg chrome "$CHROME" --headless=new --no-sandbox --remote-debugging-port="$CDP" --window-size=1440,900 \
  --hide-scrollbars --force-device-scale-factor=1 --user-data-dir="$OUT/chrome-profile" about:blank
wait_for "Chromium" 20 curl -sf "http://127.0.0.1:$CDP/json/version" || { cat "$OUT/chrome.log"; exit 1; }

export E2E_MODE=web E2E_BASE="$BASE" E2E_OUT="$OUT" CDP_PORT="$CDP" E2E_DATA_DIR="$DATA"

SMOKE=$([ "${E2E_SKIP_SMOKE:-0}" = 1 ] && echo 0 || echo 1)

if [ "$SMOKE" = 1 ]; then E2E_PHASE=main node scripts/e2e/smoke.mjs || RC=1; fi

if [ "$SMOKE" = 1 ]; then
# A18: restart the backend with the same data dir (the browser profile, i.e. localStorage, stays).
echo "--- restarting the API server"
stop_bg "$API_PGID"
start_api || { cat "$OUT/api.log"; RC=1; exit 1; }
E2E_PHASE=persist node scripts/e2e/smoke.mjs || RC=1
fi

# S9.3 screenshots (after the persistence check: they add their own project and chat).
if [ "${E2E_SHOTS:-0}" = 1 ]; then node scripts/e2e/shots.mjs || RC=1; fi

exit "$RC"
