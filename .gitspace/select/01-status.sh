#!/bin/bash
# Show workspace status when switching
#
# This runs every time you switch to an existing workspace.
#
# Bundle values are available as environment variables:
#   SPACE_VALUE_<KEY> - Regular values from input steps
#   SPACE_SECRET_<KEY> - Secret values from secret steps

WORKSPACE_NAME=$1
REPOSITORY=$2

echo ""
echo "=== Workspace: $WORKSPACE_NAME ==="
echo ""

# Show bundle values (proof of concept)
if [ -n "$SPACE_VALUE_DEVELOPERNAME" ]; then
  echo "Welcome back, $SPACE_VALUE_DEVELOPERNAME!"
fi

# Show that we have access to the secret (masked)
if [ -n "$SPACE_SECRET_EXAMPLEAPITOKEN" ]; then
  # Only show first 4 characters to prove we have access
  TOKEN_PREVIEW="${SPACE_SECRET_EXAMPLEAPITOKEN:0:4}..."
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
