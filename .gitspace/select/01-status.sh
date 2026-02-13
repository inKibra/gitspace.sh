#!/bin/bash
# Show workspace status when switching
#
# This runs every time you switch to an existing workspace.
#
# Bundle values are available as environment variables using bundle key names.
# Example: DEVELOPERNAME, EXAMPLEAPITOKEN

WORKSPACE_NAME=$1
REPOSITORY=$2

echo ""
echo "=== Workspace: $WORKSPACE_NAME ==="
echo ""

# Show bundle values (proof of concept)
if [ -n "$DEVELOPERNAME" ]; then
  echo "Welcome back, $DEVELOPERNAME!"
fi

# Show that we have access to the secret (masked)
if [ -n "$EXAMPLEAPITOKEN" ]; then
  # Only show first 4 characters to prove we have access
  TOKEN_PREVIEW="${EXAMPLEAPITOKEN:0:4}..."
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
