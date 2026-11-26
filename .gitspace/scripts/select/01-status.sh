#!/bin/bash
# Show workspace status when switching
#
# This runs every time you switch to an existing workspace.
#
# Bundle values are available using exact keys and uppercase snake-case aliases.
# Example alias: DEVELOPER_NAME

WORKSPACE_NAME=$1
REPOSITORY=$2

echo ""
echo "=== Workspace: $WORKSPACE_NAME ==="
echo ""

# Show bundle values (proof of concept)
if [ -n "$DEVELOPER_NAME" ]; then
  echo "Welcome back, $DEVELOPER_NAME!"
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
