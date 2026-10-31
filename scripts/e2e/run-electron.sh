#!/usr/bin/env bash
# End-to-end run against the built Electron app (prod wiring: app://harness/, backend in the main process, fake
# provider), driven over CDP. Opens a real window, so it needs a display. Uses temp data / userData dirs only, never
# ~/.config/harness. Builds first unless E2E_SKIP_BUILD=1.
#   scripts/e2e/run-electron.sh
#   E2E_SHOTS=1 …    also take the S9.3 screenshots
#   E2E_KEEP=1 …     keep the scratch dir (screenshots, logs)
set -uo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$E2E_ROOT"

ELECTRON="$E2E_ROOT/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON" ]; then
  echo "Electron binary missing; run: node node_modules/electron/install.js" >&2
  exit 2
fi
if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then echo "no display (DISPLAY / WAYLAND_DISPLAY unset)" >&2; exit 2; fi

if [ "${E2E_SKIP_BUILD:-0}" != 1 ]; then npm run build >/dev/null || { echo "build failed" >&2; exit 1; }; fi

e2e_init
CDP="$(free_port)"

start_app() {
  HARNESS_FAKE_PROVIDER=1 HARNESS_DATA_DIR="$DATA" start_bg electron "$ELECTRON" . \
    --remote-debugging-port="$CDP" --user-data-dir="$OUT/userdata"
  APP_PGID=$LAST_PGID
  wait_for "Electron window" 40 bash -c "curl -sf http://127.0.0.1:$CDP/json | grep -q '\"url\": \"app://'"
}

start_app || { cat "$OUT/electron.log"; exit 1; }

export E2E_MODE=electron E2E_BASE="app://harness/" E2E_OUT="$OUT" CDP_PORT="$CDP" E2E_DATA_DIR="$DATA"

E2E_PHASE=main node scripts/e2e/smoke.mjs || RC=1
if [ "${E2E_SHOTS:-0}" = 1 ]; then node scripts/e2e/shots.mjs || RC=1; fi

# A18: quit and relaunch with the same data dir and userData (localStorage).
echo "--- restarting the app"
stop_bg "$APP_PGID"
start_app || { cat "$OUT/electron.log"; RC=1; exit 1; }
E2E_PHASE=persist node scripts/e2e/smoke.mjs || RC=1

exit "$RC"
