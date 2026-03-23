/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── machine/ is the canonical model layer ───────────────────────────────
    // It should be a pure projection/state layer with no knowledge of backend
    // implementations, app orchestration, or agent UI hooks.
    {
      name: 'machine-no-session-backends',
      severity: 'warn',
      comment: 'machine/ defines the model — it must not import from session backend implementations',
      from: { path: '^src/machine/' },
      to: { path: '^src/session/backends/' },
    },
    {
      name: 'machine-no-app',
      severity: 'warn',
      comment: 'machine/ must not import from app-level orchestration',
      from: { path: '^src/machine/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'machine-no-agent-hooks',
      severity: 'warn',
      comment: 'machine/ must not import old agent UI hooks',
      from: { path: '^src/machine/' },
      to: { path: '^src/agents/useWorkspace' },
    },
    {
      name: 'machine-no-components',
      severity: 'warn',
      comment: 'machine/ must not import UI components',
      from: { path: '^src/machine/' },
      to: { path: '^src/components/' },
    },

    // ── tmux-lite is a self-contained library ────────────────────────────────
    // MachineSnapshot, agent-event-manager, and snapshot/build all live inside
    // lib/tmux-lite/ now. Nothing in lib/tmux-lite should reach out to serve/
    // or to src/machine/ (which is now purely app-side state management).
    {
      name: 'tmux-lite-no-serve',
      severity: 'error',
      comment: 'lib/tmux-lite is a self-contained library — agent-event-manager now lives inside it, so no reach into serve/ is needed',
      from: { path: '^src/lib/tmux-lite/' },
      to: { path: '^src/serve/' },
    },
    {
      name: 'tmux-lite-no-machine',
      severity: 'error',
      comment: 'tmux-lite owns MachineSnapshot — those types live in lib/tmux-lite/machine/ now. src/machine/ is app-side only and must not be imported by the library.',
      from: { path: '^src/lib/tmux-lite/' },
      to: { path: '^src/machine/' },
    },

    // ── tmux-lite daemon must stay self-contained ────────────────────────────
    {
      name: 'daemon-no-session',
      severity: 'warn',
      comment: 'tmux-lite daemon must not import from the session layer',
      from: { path: '^src/lib/tmux-lite/(server|agent-control|workspace-runtime)\\.ts$' },
      to: { path: '^src/session/' },
    },
    {
      name: 'daemon-no-multi-backend',
      severity: 'warn',
      comment: 'tmux-lite daemon must not import from the multi-backend UI layer',
      from: { path: '^src/lib/tmux-lite/(server|agent-control|workspace-runtime)\\.ts$' },
      to: { path: '^src/machine/multi/' },
    },
    {
      name: 'daemon-no-app',
      severity: 'warn',
      comment: 'tmux-lite daemon must not import from app orchestration',
      from: { path: '^src/lib/tmux-lite/(server|agent-control|workspace-runtime)\\.ts$' },
      to: { path: '^src/app/' },
    },

    // ── serve/ is the machine daemon (not the app) ───────────────────────────
    {
      name: 'serve-no-app',
      severity: 'warn',
      comment: 'machine serve daemon must not import from app orchestration',
      from: { path: '^src/serve/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'serve-no-multi-backend',
      severity: 'warn',
      comment: 'machine serve daemon must not import from the multi-backend UI layer',
      from: { path: '^src/serve/' },
      to: { path: '^src/machine/multi/' },
    },
    {
      name: 'serve-no-agent-hooks',
      severity: 'warn',
      comment: 'machine serve daemon must not import agent UI hooks',
      from: { path: '^src/serve/' },
      to: { path: '^src/agents/useWorkspace' },
    },

    // ── relay/ is transport-only ─────────────────────────────────────────────
    {
      name: 'relay-no-session',
      severity: 'warn',
      comment: 'relay server is transport-only — no session layer dependencies',
      from: { path: '^src/relay/' },
      to: { path: '^src/session/' },
    },
    {
      name: 'relay-no-agents',
      severity: 'warn',
      comment: 'relay server must not import agent UI hooks',
      from: { path: '^src/relay/' },
      to: { path: '^src/agents/' },
    },
    {
      name: 'relay-no-app',
      severity: 'warn',
      comment: 'relay server must not import from app orchestration',
      from: { path: '^src/relay/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'relay-no-components',
      severity: 'warn',
      comment: 'relay server must not import UI components',
      from: { path: '^src/relay/' },
      to: { path: '^src/components/' },
    },

    // ── lib/processes and lib/events are low-level libraries ─────────────────
    {
      name: 'processes-lib-no-app-or-session',
      severity: 'warn',
      comment: 'process management lib must not depend on app/session/machine/agent layers',
      from: { path: '^src/lib/processes/' },
      to: { path: '^src/(session/|machine/|app/|agents/)' },
    },
    {
      name: 'events-lib-no-app-or-session',
      severity: 'warn',
      comment: 'events lib must not depend on app/session/machine/agent layers',
      from: { path: '^src/lib/events/' },
      to: { path: '^src/(session/|machine/|app/|agents/)' },
    },

    // ── shared components must not reach into backend implementations ─────────
    {
      name: 'components-no-session-backends',
      severity: 'warn',
      comment: 'shared UI components must not import session backend implementations directly',
      from: { path: '^src/components/' },
      to: { path: '^src/session/backends/' },
    },
    {
      name: 'components-no-serve',
      severity: 'warn',
      comment: 'shared UI components must not import from the machine serve daemon',
      from: { path: '^src/components/' },
      to: { path: '^src/serve/' },
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsConfig: {
      fileName: './tsconfig.json',
    },
    moduleSystems: ['es6'],
  },
};
