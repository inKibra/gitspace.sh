#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEFAULT_SPRITE_STATE_FILE="${HOME:-/tmp}/.cache/gssh/test-sprite.state"
LEGACY_SPRITE_STATE_FILE="/tmp/gssh-test-sprite.state"
SPRITE_STATE_FILE="${SPRITE_TEST_STATE_FILE:-$DEFAULT_SPRITE_STATE_FILE}"
SPRITES_API_BASE="${SPRITES_API_BASE:-https://api.sprites.dev/v1}"

read_sprite_name_from_state() {
  local state_file="$1"
  if [[ ! -f "$state_file" || -L "$state_file" || ! -O "$state_file" ]]; then
    return 1
  fi

  local line value
  line="$(grep -E '^(export[[:space:]]+)?SPRITE_NAME=' "$state_file" | tail -n1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi

  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  if [[ -z "$value" ]]; then
    return 1
  fi

  printf '%s' "$value"
}

SPRITE_NAME="${1:-}"
if [[ -z "$SPRITE_NAME" ]]; then
  if [[ ! -f "$SPRITE_STATE_FILE" && -f "$LEGACY_SPRITE_STATE_FILE" ]]; then
    SPRITE_STATE_FILE="$LEGACY_SPRITE_STATE_FILE"
  fi

  if [[ -f "$SPRITE_STATE_FILE" ]]; then
    SPRITE_NAME="$(read_sprite_name_from_state "$SPRITE_STATE_FILE" || true)"
  fi
fi

if [[ -z "$SPRITE_NAME" ]]; then
  printf "Usage: %s <sprite-name>\n" "$0" >&2
  printf "Or ensure %s contains SPRITE_NAME.\n" "$SPRITE_STATE_FILE" >&2
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

SPRITE_NAME_ENCODED="$(bun -e 'process.stdout.write(encodeURIComponent(process.argv[1] ?? ""));' "$SPRITE_NAME")"

response="$(curl -sS -w "\n%{http_code}" -X DELETE "$SPRITES_API_BASE/sprites/$SPRITE_NAME_ENCODED" \
  -H "Authorization: Bearer $SPRITES_TOKEN_VALUE")"

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" == "404" ]]; then
  printf "Sprite %s already absent.\n" "$SPRITE_NAME"
elif [[ "$status" =~ ^2 ]]; then
  printf "Destroyed sprite %s\n" "$SPRITE_NAME"
else
  printf "Failed to destroy sprite %s (HTTP %s): %s\n" "$SPRITE_NAME" "$status" "$body" >&2
  exit 1
fi

if [[ -f "$SPRITE_STATE_FILE" ]]; then
  rm -f "$SPRITE_STATE_FILE"
fi
