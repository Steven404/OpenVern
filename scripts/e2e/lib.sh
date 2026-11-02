#!/usr/bin/env bash
# Shared helpers for run-web.sh / run-electron.sh (sourced, not executed).
#
# Everything the runners start goes into its own process group (setsid), is recorded in PGIDS, and is killed by the
# EXIT / INT / TERM trap, so no server, browser or Electron process outlives a run, even on failure or Ctrl+C.

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGIDS=()
OUT=""
RC=0

# The scratch dir (fixtures, screenshots, logs, data dirs). Kept when something failed or E2E_KEEP=1.
e2e_init() {
  OUT="${E2E_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/openvern-e2e-XXXXXX")}"
  mkdir -p "$OUT"
  DATA="$OUT/data"
  mkdir -p "$DATA"
  trap e2e_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo "e2e scratch dir: $OUT"
}

e2e_cleanup() {
  local status=$?
  local pg
  for pg in "${PGIDS[@]:-}"; do
    [ -n "$pg" ] && kill -TERM -- "-$pg" 2>/dev/null || true
  done
  sleep 0.5
  for pg in "${PGIDS[@]:-}"; do
    [ -n "$pg" ] && kill -KILL -- "-$pg" 2>/dev/null || true
  done
  if [ "$status" -eq 0 ] && [ "$RC" -eq 0 ] && [ "${E2E_KEEP:-0}" != 1 ] && [ -z "${E2E_OUT_DIR:-}" ]; then
    rm -rf "$OUT"
  else
    echo "kept $OUT (logs: *.log, screenshots: *.png)"
  fi
}

# start_bg <name> <cmd…>: run in a new session, log to $OUT/<name>.log, remember the process group; sets LAST_PGID.
start_bg() {
  local name="$1"
  shift
  setsid "$@" >>"$OUT/$name.log" 2>&1 &
  LAST_PGID=$!
  PGIDS+=("$LAST_PGID")
}

stop_bg() {
  # Main process first (lets Electron / servers exit cleanly), then the whole group.
  kill -TERM "$1" 2>/dev/null || true
  sleep 1
  kill -TERM -- "-$1" 2>/dev/null || true
  local i
  for i in $(seq 1 30); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$1" 2>/dev/null || true
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

free_port() {
  node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

wait_for() { # wait_for <label> <seconds> <cmd…>
  local label="$1" secs="$2"
  shift 2
  local i
  for i in $(seq 1 $((secs * 5))); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "timed out waiting for $label" >&2
  return 1
}

api_up() { curl -sf -H 'X-OpenVern-Client: 1' http://127.0.0.1:8787/api/health; }
