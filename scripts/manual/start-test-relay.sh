#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PORT="${RELAY_TEST_PORT:-}"
BIND="${RELAY_TEST_BIND:-127.0.0.1}"
LABEL="${RELAY_TEST_LABEL:-sprite-manual-test}"
TEST_HOME="${RELAY_TEST_HOME:-/tmp/gssh-test-relay-home}"
MODE="${RELAY_TEST_MODE:-named}"
SUBDOMAIN="${RELAY_TEST_SUBDOMAIN:-}"

STATE_FILE="${RELAY_TEST_STATE_FILE:-/tmp/gssh-test-relay.state}"
RELAY_LOG="${RELAY_TEST_RELAY_LOG:-/tmp/gssh-test-relay.log}"
CLOUDFLARED_LOG="${RELAY_TEST_CLOUDFLARED_LOG:-/tmp/gssh-test-cloudflared.log}"

QUICK_TUNNEL_MAX_ATTEMPTS="${RELAY_TEST_QUICK_TUNNEL_ATTEMPTS:-5}"
QUICK_URL_WAIT_SECONDS="${RELAY_TEST_QUICK_URL_WAIT_SECONDS:-90}"
NAMED_HEALTH_WAIT_SECONDS="${RELAY_TEST_NAMED_HEALTH_WAIT_SECONDS:-120}"

usage() {
  cat <<'EOF'
Usage: start-test-relay.sh [--named|--quick] [--subdomain <name>]

Modes:
  --named (default): use Cloudflare named tunnel token from keychain
                     key: TUNNEL_TOKEN_<subdomain>
  --quick:           use trycloudflare quick tunnel

Examples:
  bash scripts/manual/start-test-relay.sh --named --subdomain myname
  bash scripts/manual/start-test-relay.sh --named  # auto-detect primary subdomain
  bash scripts/manual/start-test-relay.sh --quick
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "Missing required command: %s\n" "$1" >&2
    exit 1
  fi
}

resolve_free_port() {
  bun -e 'import { createServer } from "node:net"; const server = createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") process.exit(1); process.stdout.write(String(address.port)); server.close(); });'
}

resolve_tunnel_token_from_keychain() {
  local subdomain="$1"
  local token_key="TUNNEL_TOKEN_${subdomain}"

  if [[ -n "${RELAY_TEST_TUNNEL_TOKEN:-}" ]]; then
    printf "%s" "$RELAY_TEST_TUNNEL_TOKEN"
    return 0
  fi

  (
    cd "$REPO_ROOT"
    bun -e 'const { getSecret } = await import("./src/utils/secrets.ts"); const key = process.argv[1] ?? ""; const value = await getSecret(key); if (!value) process.exit(1); process.stdout.write(value);' "$token_key"
  )
}

resolve_primary_subdomain_from_account() {
  (
    cd "$REPO_ROOT"
    bun -e 'const { syncHostConfig, readHostConfig } = await import("./src/commands/host.ts"); await syncHostConfig(false); const cfg = readHostConfig(); if (!cfg?.subdomain) process.exit(1); process.stdout.write(cfg.subdomain);'
  )
}

cleanup_on_error() {
  local exit_code=$?
  if [[ "$exit_code" -eq 0 ]]; then
    return
  fi

  if [[ -n "${CLOUDFLARED_PID:-}" ]] && kill -0 "$CLOUDFLARED_PID" >/dev/null 2>&1; then
    kill "$CLOUDFLARED_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${RELAY_PID:-}" ]] && kill -0 "$RELAY_PID" >/dev/null 2>&1; then
    kill "$RELAY_PID" >/dev/null 2>&1 || true
  fi

  [[ -n "${STATE_FILE:-}" ]] && rm -f "$STATE_FILE" >/dev/null 2>&1 || true
  [[ -n "${RELAY_LOG:-}" ]] && rm -f "$RELAY_LOG" >/dev/null 2>&1 || true
  [[ -n "${CLOUDFLARED_LOG:-}" ]] && rm -f "$CLOUDFLARED_LOG" >/dev/null 2>&1 || true
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      MODE="quick"
      shift
      ;;
    --named)
      MODE="named"
      shift
      ;;
    --subdomain)
      if [[ $# -lt 2 ]]; then
        printf "--subdomain requires a value\n" >&2
        exit 1
      fi
      SUBDOMAIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf "Unknown argument: %s\n\n" "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_command bun
require_command cloudflared
require_command grep
require_command curl

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  if [[ -n "${RELAY_PID:-}" ]] && kill -0 "$RELAY_PID" >/dev/null 2>&1; then
    printf "Existing test relay appears to be running (PID %s).\n" "$RELAY_PID" >&2
    printf "Stop it first with: %s\n" "$REPO_ROOT/scripts/manual/stop-test-relay.sh" >&2
    exit 1
  fi
fi

if [[ "$MODE" == "named" && -z "$SUBDOMAIN" ]]; then
  if SUBDOMAIN="$(resolve_primary_subdomain_from_account 2>/dev/null)"; then
    if [[ -n "$SUBDOMAIN" ]]; then
      printf "Auto-detected primary subdomain: %s\n" "$SUBDOMAIN"
    fi
  fi

  if [[ -z "$SUBDOMAIN" ]]; then
    printf "Named tunnel mode requires a subdomain and none could be auto-detected.\n" >&2
    printf "Set RELAY_TEST_SUBDOMAIN or pass --subdomain <name>.\n" >&2
    printf "If needed, reserve one first: gssh user host reserve <name>\n" >&2
    exit 1
  fi
fi

if [[ -z "$PORT" ]]; then
  if [[ "$MODE" == "named" ]]; then
    PORT="4480"
  else
    PORT="$(resolve_free_port)"
  fi
fi

if [[ "$MODE" == "named" && "$PORT" != "4480" ]]; then
  printf "Warning: named tunnel tokens are typically configured for localhost:4480.\n" >&2
  printf "Current RELAY_TEST_PORT=%s may not receive traffic from cloudflared.\n" "$PORT" >&2
fi

mkdir -p "$TEST_HOME"

RELAY_PRIVATE_KEY="$(bun -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64"));')"
RELAY_PUBKEY="$(RELAY_PRIVATE_KEY="$RELAY_PRIVATE_KEY" bun -e 'import { ed25519 } from "@noble/curves/ed25519.js"; const privateKey = new Uint8Array(Buffer.from(process.env.RELAY_PRIVATE_KEY ?? "", "base64")); const publicKey = ed25519.getPublicKey(privateKey); process.stdout.write(Buffer.from(publicKey).toString("base64"));')"

rm -f "$RELAY_LOG" "$CLOUDFLARED_LOG"

(
  cd "$REPO_ROOT"
  HOME="$TEST_HOME" RELAY_PRIVATE_KEY="$RELAY_PRIVATE_KEY" RELAY_PORT="$PORT" RELAY_BIND="$BIND" RELAY_LABEL="$LABEL" bun src/relay/index.ts >"$RELAY_LOG" 2>&1
) &
RELAY_PID=$!

sleep 1
if ! kill -0 "$RELAY_PID" >/dev/null 2>&1; then
  printf "Relay failed to start.\n" >&2
  printf "See log: %s\n" "$RELAY_LOG" >&2
  exit 1
fi

CLOUDFLARED_PID=""
RELAY_WS=""
RELAY_HEALTH=""
trap cleanup_on_error EXIT

if [[ "$MODE" == "named" ]]; then
  TUNNEL_TOKEN=""
  if ! TUNNEL_TOKEN="$(resolve_tunnel_token_from_keychain "$SUBDOMAIN")"; then
    printf "No named tunnel token found in keychain for subdomain '%s'.\n" "$SUBDOMAIN" >&2
    printf "Expected key: TUNNEL_TOKEN_%s\n" "$SUBDOMAIN" >&2
    printf "Run: gssh user host reserve %s (or gssh user host status)\n" "$SUBDOMAIN" >&2
    exit 1
  fi

  RELAY_HEALTH="https://${SUBDOMAIN}.gitspace.sh/health"
  RELAY_WS="wss://${SUBDOMAIN}.gitspace.sh/ws"

  (
    cd "$REPO_ROOT"
    TUNNEL_TOKEN="$TUNNEL_TOKEN" cloudflared tunnel run --url "http://$BIND:$PORT" >"$CLOUDFLARED_LOG" 2>&1
  ) &
  CLOUDFLARED_PID=$!

  tunnel_connected="0"
  for _ in $(seq 1 "$NAMED_HEALTH_WAIT_SECONDS"); do
    if ! kill -0 "$CLOUDFLARED_PID" >/dev/null 2>&1; then
      printf "cloudflared exited before relay health became reachable.\n" >&2
      printf "See log: %s\n" "$CLOUDFLARED_LOG" >&2
      exit 1
    fi

    if grep -q "Registered tunnel connection" "$CLOUDFLARED_LOG"; then
      tunnel_connected="1"
      break
    fi
    sleep 1
  done

  if [[ "$tunnel_connected" != "1" ]]; then
    printf "Named tunnel did not establish any edge connections in time.\n" >&2
    printf "See cloudflared log: %s\n" "$CLOUDFLARED_LOG" >&2
    exit 1
  fi

  last_status="$(curl -s -o /dev/null -w "%{http_code}" "$RELAY_HEALTH" || true)"
  if [[ "$last_status" != "200" ]]; then
    printf "Warning: named tunnel health probe returned %s at %s.\n" "$last_status" "$RELAY_HEALTH" >&2
    printf "Continuing; remote sprite WS probe will verify end-to-end connectivity.\n" >&2
  fi
else
  tunnel_ready="0"
  for attempt in $(seq 1 "$QUICK_TUNNEL_MAX_ATTEMPTS"); do
    rm -f "$CLOUDFLARED_LOG"
    cloudflared tunnel --url "http://$BIND:$PORT" --no-autoupdate >"$CLOUDFLARED_LOG" 2>&1 &
    CLOUDFLARED_PID=$!

    TUNNEL_URL=""
    for _ in $(seq 1 "$QUICK_URL_WAIT_SECONDS"); do
      if [[ -f "$CLOUDFLARED_LOG" ]]; then
        TUNNEL_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | tail -n 1 || true)"
      fi
      if [[ -n "$TUNNEL_URL" ]]; then
        break
      fi
      if ! kill -0 "$CLOUDFLARED_PID" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    if [[ -z "$TUNNEL_URL" ]]; then
      printf "Quick tunnel attempt %s/%s failed to produce URL; retrying...\n" "$attempt" "$QUICK_TUNNEL_MAX_ATTEMPTS" >&2
      kill "$CLOUDFLARED_PID" >/dev/null 2>&1 || true
      sleep 1
      continue
    fi

    RELAY_WS="${TUNNEL_URL/https:/wss:}/ws"
    RELAY_HEALTH="$TUNNEL_URL/health"
    tunnel_ready="1"
    break
  done

  if [[ "$tunnel_ready" != "1" ]]; then
    printf "Quick tunnel URL did not become ready after %s attempts.\n" "$QUICK_TUNNEL_MAX_ATTEMPTS" >&2
    printf "See cloudflared log: %s\n" "$CLOUDFLARED_LOG" >&2
    exit 1
  fi
fi

trap - EXIT

cat >"$STATE_FILE" <<EOF
RELAY_PID=$RELAY_PID
CLOUDFLARED_PID=$CLOUDFLARED_PID
RELAY_MODE=$MODE
RELAY_SUBDOMAIN=${SUBDOMAIN}
RELAY_WS=$RELAY_WS
RELAY_HEALTH=$RELAY_HEALTH
RELAY_PUBKEY=$RELAY_PUBKEY
RELAY_PORT=$PORT
RELAY_TEST_HOME=$TEST_HOME
RELAY_LOG=$RELAY_LOG
CLOUDFLARED_LOG=$CLOUDFLARED_LOG
STATE_FILE=$STATE_FILE
EOF
chmod 600 "$STATE_FILE"

printf "\n"
printf "Test relay started.\n"
printf "Mode:             %s\n" "$MODE"
if [[ -n "$SUBDOMAIN" ]]; then
  printf "Subdomain:        %s\n" "$SUBDOMAIN"
fi
printf "Relay PID:        %s\n" "$RELAY_PID"
printf "Cloudflared PID:  %s\n" "$CLOUDFLARED_PID"
printf "Relay WS URL:     %s\n" "$RELAY_WS"
printf "Relay health URL: %s\n" "$RELAY_HEALTH"
printf "Relay pubkey:     %s\n" "$RELAY_PUBKEY"
printf "State file:       %s\n" "$STATE_FILE"
printf "\n"
printf "Cleanup command:  %s\n" "$REPO_ROOT/scripts/manual/stop-test-relay.sh"
