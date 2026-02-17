#!/bin/bash
# Show workspace status when switching
#
# This runs every time you switch to an existing workspace.
#
# Bundle values are available using exact keys and uppercase snake-case aliases.
# Example aliases: DEVELOPER_NAME, EXAMPLE_API_TOKEN

WORKSPACE_NAME=$1
REPOSITORY=$2

echo ""
echo "=== Workspace: $WORKSPACE_NAME ==="
echo ""

# Show bundle values (proof of concept)
if [ -n "$DEVELOPER_NAME" ]; then
  echo "Welcome back, $DEVELOPER_NAME!"
fi

# Show that we have access to the secret (masked)
if [ -n "$EXAMPLE_API_TOKEN" ]; then
  # Only show first 4 characters to prove we have access
  TOKEN_PREVIEW="${EXAMPLE_API_TOKEN:0:4}..."
  echo "API Token available: $TOKEN_PREVIEW (stored in OS keychain)"
fi

echo ""

# Show git status summary
echo "Git Status:"
git status --short

# Show branch info
echo ""
echo "Branch:"
git branch --show-current

echo ""
