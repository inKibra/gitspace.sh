#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${RELAY_TEST_STATE_FILE:-/tmp/gssh-test-relay.state}"

if [[ ! -f "$STATE_FILE" ]]; then
  printf "No relay state file found at %s\n" "$STATE_FILE"
  exit 0
fi

# shellcheck disable=SC1090
source "$STATE_FILE"

if [[ -n "${CLOUDFLARED_PID:-}" ]] && kill -0 "$CLOUDFLARED_PID" >/dev/null 2>&1; then
  kill "$CLOUDFLARED_PID" >/dev/null 2>&1 || true
  printf "Stopped cloudflared PID %s\n" "$CLOUDFLARED_PID"
fi

if [[ -n "${RELAY_PID:-}" ]] && kill -0 "$RELAY_PID" >/dev/null 2>&1; then
  kill "$RELAY_PID" >/dev/null 2>&1 || true
  printf "Stopped relay PID %s\n" "$RELAY_PID"
fi

if [[ -n "${RELAY_PORT:-}" ]]; then
  relay_pids="$(lsof -nP -iTCP:"$RELAY_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$relay_pids" ]]; then
    for pid in $relay_pids; do
      cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$cmdline" == *"src/relay/index.ts"* ]]; then
        kill "$pid" >/dev/null 2>&1 || true
        printf "Stopped relay listener PID %s on port %s\n" "$pid" "$RELAY_PORT"
      fi
    done
  fi
fi

if [[ -n "${RELAY_TEST_HOME:-}" ]] && [[ -d "${RELAY_TEST_HOME}" ]]; then
  rm -rf "${RELAY_TEST_HOME}"
  printf "Removed relay HOME %s\n" "${RELAY_TEST_HOME}"
fi

rm -f "$STATE_FILE"
printf "Removed state file %s\n" "$STATE_FILE"
