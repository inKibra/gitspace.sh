#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RELAY_STATE_FILE="${RELAY_TEST_STATE_FILE:-/tmp/gssh-test-relay.state}"
SPRITE_STATE_FILE="${SPRITE_TEST_STATE_FILE:-/tmp/gssh-test-sprite.state}"
SPRITES_API_BASE="${SPRITES_API_BASE:-https://api.sprites.dev/v1}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf "Missing required command: %s\n" "$1" >&2
    exit 1
  fi
}

require_command bash
require_command bun
require_command curl
require_command jq

if [[ -f "$RELAY_STATE_FILE" ]]; then
  bash "$SCRIPT_DIR/stop-test-relay.sh" >/dev/null 2>&1 || true
fi

rm -f "$SPRITE_STATE_FILE"

if [[ $# -gt 0 ]]; then
  bash "$SCRIPT_DIR/start-test-relay.sh" "$@"
else
  bash "$SCRIPT_DIR/start-test-relay.sh"
fi

# shellcheck disable=SC1090
source "$RELAY_STATE_FILE"

if [[ -z "${RELAY_WS:-}" || -z "${RELAY_HEALTH:-}" || -z "${RELAY_PUBKEY:-}" ]]; then
  printf "Relay state file missing required values: %s\n" "$RELAY_STATE_FILE" >&2
  exit 1
fi

SPRITES_TOKEN_VALUE="${SPRITES_TOKEN:-}"
if [[ -z "$SPRITES_TOKEN_VALUE" ]]; then
  SPRITES_TOKEN_VALUE="$({
    cd "$REPO_ROOT"
    bun -e 'const { getSpritesToken } = await import("./src/relay/control/provider-config.ts"); const token = await getSpritesToken(); if (!token) process.exit(1); process.stdout.write(token);'
  })"
fi

if [[ -z "$SPRITES_TOKEN_VALUE" ]]; then
  printf "Could not resolve SPRITES_TOKEN (env or keychain).\n" >&2
  exit 1
fi

make_sprite_name() {
  local suffix
  suffix="$(bun -e 'process.stdout.write(Math.random().toString(36).slice(2, 8));')"
  printf "manual-netcheck-%s-%s" "$(date +%s)" "$suffix"
}

SPRITE_NAME="${SPRITE_TEST_NAME:-$(make_sprite_name)}"

create_sprite() {
  local name="$1"
  local body http_code
  local payload
  payload="$(jq -cn --arg name "$name" '{name:$name}')"

  body="$(curl -sS -w "\n%{http_code}" -X POST "$SPRITES_API_BASE/sprites" \
    -H "Authorization: Bearer $SPRITES_TOKEN_VALUE" \
    -H "Content-Type: application/json" \
    -d "$payload")"

  http_code="${body##*$'\n'}"
  body="${body%$'\n'*}"

  if [[ "$http_code" =~ ^2 ]]; then
    printf "%s" "$body"
    return 0
  fi

  printf "HTTP_%s\n%s" "$http_code" "$body"
  return 1
}

create_result=""
for attempt in 1 2 3; do
  if create_result="$(create_sprite "$SPRITE_NAME")"; then
    break
  fi

  if [[ "$create_result" == *"already exists"* ]]; then
    SPRITE_NAME="$(make_sprite_name)"
    continue
  fi

  if [[ "$create_result" == HTTP_5* ]]; then
    if curl -sS -o /dev/null -H "Authorization: Bearer $SPRITES_TOKEN_VALUE" "$SPRITES_API_BASE/sprites/$SPRITE_NAME"; then
      break
    fi
  fi

  if [[ "$attempt" == "3" ]]; then
    printf "Failed to create sprite after retries:\n%s\n" "$create_result" >&2
    exit 1
  fi

  sleep 2
done

VERIFY_SCRIPT_PATH="/tmp/verify-relay-connectivity.sh"
SPRITE_NAME_ENCODED="$(bun -e 'process.stdout.write(encodeURIComponent(process.argv[1] ?? ""));' "$SPRITE_NAME")"
WRITE_URL="$SPRITES_API_BASE/sprites/$SPRITE_NAME_ENCODED/fs/write?path=%2Ftmp%2Fverify-relay-connectivity.sh&workingDir=%2F&mkdir=true&mode=0755"

IFS='' read -r -d '' VERIFY_SCRIPT_TEMPLATE <<'EOF' || true
#!/usr/bin/env bash
set -euo pipefail

RELAY_WS='__RELAY_WS__'
RELAY_HEALTH='__RELAY_HEALTH__'
RELAY_PUBKEY='__RELAY_PUBKEY__'

echo "Relay health URL: $RELAY_HEALTH"
echo "Relay WS URL: $RELAY_WS"
echo "Relay pubkey: $RELAY_PUBKEY"
echo
echo '=== HTTP health probe ==='
curl -sv --max-time 20 "$RELAY_HEALTH" || true
echo
echo '=== WS probe (bun) ==='
if [[ -x '/.sprite/languages/bun/bin/bun' ]]; then
  BUN_BIN='/.sprite/languages/bun/bin/bun'
elif command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
else
  echo 'Bun is not installed in this sprite image.' >&2
  exit 2
fi

"$BUN_BIN" -e '
const relayWs = process.argv[1];
const wsUrl = relayWs.includes("?") ? `${relayWs}&role=machine` : `${relayWs}?role=machine`;
const ws = new WebSocket(wsUrl);
const timeout = setTimeout(() => {
  console.error("ws-timeout");
  process.exit(2);
}, 15000);
ws.onopen = () => {
  clearTimeout(timeout);
  console.log("ws-open");
  ws.close();
  process.exit(0);
};
ws.onerror = (event) => {
  clearTimeout(timeout);
  console.error("ws-error", event?.message ?? "");
  process.exit(1);
};
' "$RELAY_WS"
EOF

VERIFY_SCRIPT_CONTENT="${VERIFY_SCRIPT_TEMPLATE//__RELAY_WS__/$RELAY_WS}"
VERIFY_SCRIPT_CONTENT="${VERIFY_SCRIPT_CONTENT//__RELAY_HEALTH__/$RELAY_HEALTH}"
VERIFY_SCRIPT_CONTENT="${VERIFY_SCRIPT_CONTENT//__RELAY_PUBKEY__/$RELAY_PUBKEY}"

write_response="$(curl -sS -w "\n%{http_code}" -X PUT "$WRITE_URL" \
  -H "Authorization: Bearer $SPRITES_TOKEN_VALUE" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "$VERIFY_SCRIPT_CONTENT")"

write_status="${write_response##*$'\n'}"
write_body="${write_response%$'\n'*}"
if [[ ! "$write_status" =~ ^2 ]]; then
  printf "Failed to upload verification script (status %s):\n%s\n" "$write_status" "$write_body" >&2
  exit 1
fi

cat >"$SPRITE_STATE_FILE" <<EOF
SPRITE_NAME=$SPRITE_NAME
SPRITE_VERIFY_SCRIPT=$VERIFY_SCRIPT_PATH
SPRITES_API_BASE=$SPRITES_API_BASE
EOF
chmod 600 "$SPRITE_STATE_FILE"

printf "\n"
printf "Ready. Use exactly these 3 steps:\n\n"
printf "1) Started relay + sprite (done).\n"
printf "   relay mode: %s\n" "${RELAY_MODE:-unknown}"
if [[ -n "${RELAY_SUBDOMAIN:-}" ]]; then
  printf "   relay subdomain: %s\n" "${RELAY_SUBDOMAIN}"
fi
printf "   sprite: %s\n" "$SPRITE_NAME"
printf "   relay ws: %s\n" "$RELAY_WS"
printf "   relay pubkey: %s\n\n" "$RELAY_PUBKEY"

printf "2) Open a shell in the sprite with your Sprites CLI.\n"
printf "   Use your known working command to open sprite: %s\n\n" "$SPRITE_NAME"

printf "3) Inside the sprite shell, run:\n"
printf "   bash %s\n\n" "$VERIFY_SCRIPT_PATH"

printf "Cleanup:\n"
printf "  - Destroy sprite: bash %s %s\n" "$SCRIPT_DIR/destroy-test-sprite.sh" "$SPRITE_NAME"
printf "  - Stop relay:     bash %s\n" "$SCRIPT_DIR/stop-test-relay.sh"
