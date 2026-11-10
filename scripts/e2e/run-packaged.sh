#!/usr/bin/env bash
# End-to-end run against a PACKAGED build (the release .app on macOS, an AppImage on Linux), driven over CDP the same
# way run-electron.sh drives the unpackaged app: smoke (main + persist), edits and archive. Uses temp data / userData
# dirs and the fake provider. Does not build: package first (npm run dist:mac, or the validation build for AS-10/11).
#   npm run e2e:packaged                        macOS: the AS-10 validation package (D-KC-PKG)
#   E2E_APP=<path> npm run e2e:packaged         a .app (macOS) or an AppImage (Linux)
#   E2E_ALLOW_REAL_IDENTITY=1 …                 allow the real dev.stefanos.openvern bundle (needs your approval, X2)
#   E2E_STEP_TIMEOUT=<secs> …                   per-step stall guard (default 300)
#   E2E_KEEP=1 …                                keep the scratch dir (logs, screenshots)
# Keychain (KC-ISO): a packaged run uses safeStorage, which may read or create `<name> Safe Storage`. A step that stalls
# (for example behind a prompt) fails after E2E_STEP_TIMEOUT with a hint instead of hanging.
set -uo pipefail
# Agent hosts / Electron IDEs export ELECTRON_RUN_AS_NODE=1, which would run the app as plain Node.
unset ELECTRON_RUN_AS_NODE
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$E2E_ROOT"

VALIDATION_APP="/private/tmp/openvern-as10-validation/mac-arm64/openvern.app"
REAL_BUNDLE_ID="dev.stefanos.openvern"
STEP_TIMEOUT="${E2E_STEP_TIMEOUT:-300}"
STALL_HINT="a Keychain prompt may be waiting: click Always Allow, or rerun with a validation package (E2E_APP=<validation .app>)."
CDP=""
APP_PGID=""
BIN=""

if [ "$(uname -s)" = Darwin ]; then
  # macOS needs a logged-in GUI session. launchctl reports "Aqua" there and something else over plain SSH.
  if [ "$(launchctl managername 2>/dev/null)" != Aqua ]; then
    echo "needs a logged-in GUI session (not plain SSH)" >&2
    exit 2
  fi
  if [ -z "${E2E_APP:-}" ]; then
    if [ -d "$VALIDATION_APP" ]; then
      E2E_APP="$VALIDATION_APP"
    else
      echo "No E2E_APP set and the validation package is missing: $VALIDATION_APP" >&2
      echo "Build it (see reports/apple-silicon-as10.md) or set E2E_APP=<path to a .app>." >&2
      exit 2
    fi
  fi
  if [ ! -d "$E2E_APP" ]; then
    echo "E2E_APP is not a directory: $E2E_APP" >&2
    exit 2
  fi
  # The binary is the bundle's CFBundleExecutable (executableName: openvern), not the product name.
  exe="$(plutil -extract CFBundleExecutable raw "$E2E_APP/Contents/Info.plist" 2>/dev/null)" || exe=""
  bundle_id="$(plutil -extract CFBundleIdentifier raw "$E2E_APP/Contents/Info.plist" 2>/dev/null)" || bundle_id=""
  BIN="$E2E_APP/Contents/MacOS/$exe"
  if [ -z "$exe" ] || [ ! -x "$BIN" ]; then
    echo "no executable in $E2E_APP (CFBundleExecutable: '$exe')" >&2
    exit 2
  fi
  bundle_name="$(plutil -extract CFBundleName raw "$E2E_APP/Contents/Info.plist" 2>/dev/null)" || bundle_name=""
  # Fail closed: the Keychain item is named after the app name, so an empty id or the real name also counts as real.
  if { [ -z "$bundle_id" ] || [ "$bundle_id" = "$REAL_BUNDLE_ID" ] || [ -z "$bundle_name" ] || [ "$bundle_name" = "OpenVern" ]; } &&
    [ "${E2E_ALLOW_REAL_IDENTITY:-0}" != 1 ]; then
    echo "E2E_APP may be the real identity (bundle id '$bundle_id', name '$bundle_name'). This run would read or create the real" >&2
    echo "'OpenVern Safe Storage' item (KC-ISO X2). Use a validation package, or set E2E_ALLOW_REAL_IDENTITY=1 after approval." >&2
    exit 2
  fi
  echo "packaged app: $E2E_APP (bundle id $bundle_id, binary $exe)"
else
  if [ -z "${E2E_APP:-}" ]; then
    echo "Set E2E_APP=<path to the AppImage> (no default on Linux)." >&2
    exit 2
  fi
  if [ ! -x "$E2E_APP" ]; then
    echo "E2E_APP is not an executable AppImage: $E2E_APP" >&2
    exit 2
  fi
  if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    echo "no display (DISPLAY / WAYLAND_DISPLAY unset)" >&2
    exit 2
  fi
  BIN="$E2E_APP"
  echo "packaged app: $E2E_APP"
fi


e2e_init
CDP="$(free_port)"

start_app() {
  OPENVERN_FAKE_PROVIDER=1 OPENVERN_DATA_DIR="$DATA" start_bg packaged "$BIN" \
    --remote-debugging-port="$CDP" --user-data-dir="$OUT/userdata" || return 1
  APP_PGID=$LAST_PGID
  wait_for "packaged window" "$STEP_TIMEOUT" bash -c "curl -sf http://127.0.0.1:$CDP/json | grep -q '\"url\": \"app://'"
}

# run_step <label> <cmd…>: run the command in the background and poll it. Past STEP_TIMEOUT it is killed and the stall
# hint is printed, so a blocked step fails instead of hanging. Returns the command's status.
run_step() {
  local label="$1" pid i=0 limit
  shift
  limit=$((STEP_TIMEOUT * 5))
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge "$limit" ]; then
      echo "$label stalled after ${STEP_TIMEOUT}s. $STALL_HINT" >&2
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 0.2
    i=$((i + 1))
  done
  wait "$pid"
}

if ! start_app; then
  cat "$OUT/packaged.log" 2>/dev/null
  echo "The packaged window did not appear. $STALL_HINT" >&2
  exit 1
fi

export E2E_MODE=electron E2E_BASE="app://openvern/" E2E_OUT="$OUT" CDP_PORT="$CDP" E2E_DATA_DIR="$DATA"

E2E_PHASE=main run_step "smoke (main)" node scripts/e2e/smoke.mjs || RC=1

# A18: quit and relaunch with the same data dir and userData (localStorage).
echo "--- restarting the packaged app"
stop_bg "$APP_PGID"
if ! start_app; then
  cat "$OUT/packaged.log" 2>/dev/null
  echo "The packaged window did not appear after restart. $STALL_HINT" >&2
  exit 1
fi
E2E_PHASE=persist run_step "smoke (persist)" node scripts/e2e/smoke.mjs || RC=1

# v0.2 edit / review flow (G7.1).
run_step "edits" node scripts/e2e/edits.mjs || RC=1

# F2 archive project chats (plan §6 F2.6).
run_step "archive" node scripts/e2e/archive.mjs || RC=1

exit "$RC"
