#!/usr/bin/env bash
# End-to-end run against the built Electron app (prod wiring: app://openvern/, backend in the main process, fake
# provider), driven over CDP. Opens a real window, so it needs a display. Uses temp data / userData dirs only, never
# ~/.config/openvern. Builds first unless E2E_SKIP_BUILD=1.
#   scripts/e2e/run-electron.sh
#   E2E_SHOTS=1 …    also take the S9.3 screenshots (E2E_SKIP_SMOKE=1: only those)
#   E2E_KEEP=1 …     keep the scratch dir (screenshots, logs)
set -uo pipefail
# Agent hosts / Electron IDEs export ELECTRON_RUN_AS_NODE=1, which would run the app as plain Node.
unset ELECTRON_RUN_AS_NODE
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
  OPENVERN_FAKE_PROVIDER=1 OPENVERN_DATA_DIR="$DATA" start_bg electron "$ELECTRON" . \
    --remote-debugging-port="$CDP" --user-data-dir="$OUT/userdata"
  APP_PGID=$LAST_PGID
  wait_for "Electron window" 40 bash -c "curl -sf http://127.0.0.1:$CDP/json | grep -q '\"url\": \"app://'"
}

start_app || { cat "$OUT/electron.log"; exit 1; }

export E2E_MODE=electron E2E_BASE="app://openvern/" E2E_OUT="$OUT" CDP_PORT="$CDP" E2E_DATA_DIR="$DATA"

SMOKE=$([ "${E2E_SKIP_SMOKE:-0}" = 1 ] && echo 0 || echo 1)

if [ "$SMOKE" = 1 ]; then E2E_PHASE=main node scripts/e2e/smoke.mjs || RC=1; fi

if [ "$SMOKE" = 1 ]; then
# A18: quit and relaunch with the same data dir and userData (localStorage).
echo "--- restarting the app"
stop_bg "$APP_PGID"
start_app || { cat "$OUT/electron.log"; RC=1; exit 1; }
E2E_PHASE=persist node scripts/e2e/smoke.mjs || RC=1
fi

# v0.2 edit / review flow (G7.1).
if [ "${E2E_SKIP_EDITS:-0}" != 1 ]; then node scripts/e2e/edits.mjs || RC=1; fi

# S9.3 screenshots (after the persistence check: they add their own project and chat).
if [ "${E2E_SHOTS:-0}" = 1 ]; then node scripts/e2e/shots.mjs || RC=1; fi

exit "$RC"
