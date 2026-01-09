#!/bin/bash
# tmux-lite shell integration
# Source this file in your .bashrc or .zshrc to enable inbox notifications
#
# Usage: source /path/to/shell-integration.sh
#
# This sends exit codes to tmux-lite server after each command,
# which creates inbox notifications for non-zero exits.

# Only run if inside tmux-lite session
if [[ -z "$TMUX_LITE" ]]; then
  return 0 2>/dev/null || exit 0
fi

# Send OSC 777 with exit code
__tmux_lite_report_exit() {
  local exit_code=$?
  # Only report non-zero exits (failures)
  if [[ $exit_code -ne 0 ]]; then
    printf '\033]777;exit:%d\007' "$exit_code"
  fi
  return $exit_code
}

# Detect shell and install hook
if [[ -n "$ZSH_VERSION" ]]; then
  # Zsh: use precmd hook
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __tmux_lite_report_exit
elif [[ -n "$BASH_VERSION" ]]; then
  # Bash: use PROMPT_COMMAND
  if [[ -z "$__TMUX_LITE_PROMPT_INSTALLED" ]]; then
    export __TMUX_LITE_PROMPT_INSTALLED=1
    # Prepend to PROMPT_COMMAND to run before prompt
    PROMPT_COMMAND="__tmux_lite_report_exit${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
fi
