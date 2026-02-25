#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SPRITE_STATE_FILE="${SPRITE_TEST_STATE_FILE:-/tmp/gssh-test-sprite.state}"
SPRITES_API_BASE="${SPRITES_API_BASE:-https://api.sprites.dev/v1}"

SPRITE_NAME="${1:-}"
if [[ -z "$SPRITE_NAME" && -f "$SPRITE_STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SPRITE_STATE_FILE"
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
