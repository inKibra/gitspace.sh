#!/bin/bash
# Run initial typecheck to verify setup
#
# This runs once when the workspace is first created.

WORKSPACE_NAME=$1
REPOSITORY=$2

echo "Running typecheck..."
bun run typecheck

if [ $? -eq 0 ]; then
  echo "Typecheck passed!"
else
  echo "Typecheck had issues - you may need to fix some things."
fi
