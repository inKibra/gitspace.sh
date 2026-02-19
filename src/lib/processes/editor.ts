export const PROCESSES_CONFIG_TEMPLATE = [
  '{',
  '  // Managed process definitions for this workspace.',
  '  // Uncomment and edit the example below, then save and exit.',
  '  "processes": [',
  '    // {',
  '    //   "name": "web",',
  '    //   "command": "bun",',
  '    //   "args": ["run", "dev"],',
  '    //   "autostart": false',
  '    // }',
  '  ]',
  '}',
  '',
].join('\n');

export function buildEditProcessesCommand(): { command: string; args: string[] } {
  const shellScript = [
    'mkdir -p .gitspace',
    'if [ ! -f .gitspace/processes.json ]; then',
    "  cat > .gitspace/processes.json <<'JSONC'",
    PROCESSES_CONFIG_TEMPLATE,
    'JSONC',
    'fi',
    'exec "${EDITOR:-vi}" .gitspace/processes.json',
  ].join('\n');

  return {
    command: 'sh',
    args: ['-c', shellScript],
  };
}
