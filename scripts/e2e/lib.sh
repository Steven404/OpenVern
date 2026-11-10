#!/usr/bin/env bash
# Shared helpers for run-web.sh / run-electron.sh (sourced, not executed).
#
# Everything the runners start goes into its own process group (setsid on Linux, spawn-group.mjs where setsid is
# missing, e.g. macOS), is recorded in PGIDS, and is killed by the EXIT / INT / TERM trap, so no server, browser or
# Electron process outlives a run, even on failure or Ctrl+C.

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGIDS=()
OUT=""
RC=0

# is_pgid <n>: true only for a process group we may signal, a positive integer above 1. `kill -- -0` would hit the
# caller's own group (the shell), and an empty or non-numeric value must never reach `kill`.
is_pgid() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 1 ]
}

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
    if is_pgid "$pg"; then kill -TERM -- "-$pg" 2>/dev/null || true; fi
  done
  sleep 0.5
  for pg in "${PGIDS[@]:-}"; do
    if is_pgid "$pg"; then kill -KILL -- "-$pg" 2>/dev/null || true; fi
  done
  if [ "$status" -eq 0 ] && [ "$RC" -eq 0 ] && [ "${E2E_KEEP:-0}" != 1 ] && [ -z "${E2E_OUT_DIR:-}" ]; then
    rm -rf "$OUT"
  else
    echo "kept $OUT (logs: *.log, screenshots: *.png)"
  fi
}

# start_bg <name> <cmd…>: run in a new session (its own process group, PGID = PID), log to $OUT/<name>.log, record the
# group in PGIDS and set LAST_PGID. Returns 1 if the command could not be started.
# Linux uses setsid, unchanged. Elsewhere spawn-group.mjs starts the command detached and prints its PID, which is
# captured synchronously here and checked to be a bare number.
start_bg() {
  local name="$1" pid
  shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >>"$OUT/$name.log" 2>&1 &
    pid=$!
  else
    pid="$(node "$E2E_ROOT/scripts/e2e/spawn-group.mjs" "$OUT/$name.log" "$@")" || {
      echo "could not start $name" >&2
      return 1
    }
    case "$pid" in
      '' | *[!0-9]*)
        echo "could not capture the PID of $name (got: '$pid')" >&2
        return 1
        ;;
    esac
  fi
  if ! is_pgid "$pid"; then
    echo "bad process group id for $name: '$pid'" >&2
    return 1
  fi
  LAST_PGID=$pid
  PGIDS+=("$pid")
}

# stop_bg <pgid>: stop the leader first (lets Electron and the servers exit cleanly), then TERM the whole group, wait
# until the group is empty, and KILL whatever survives. Liveness is checked on the group (kill -0 -- -PGID), not only on
# the leader, so a member that outlives its leader is still stopped.
stop_bg() {
  local pg="$1" i
  is_pgid "$pg" || return 0
  kill -TERM "$pg" 2>/dev/null || true
  sleep 1
  kill -TERM -- "-$pg" 2>/dev/null || true
  for i in $(seq 1 30); do
    kill -0 -- "-$pg" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$pg" 2>/dev/null || true
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
