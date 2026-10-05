/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'isomorphic-domains-have-no-runtime-dependencies',
      severity: 'error',
      comment: 'Domain rules import pure domain packages, not runtime adapters or the umbrella protocol.',
      from: { path: '^packages/protocol-[^/]+/src/' },
      to: { path: '^packages/(?!protocol-[^/]+/|blocks/)' },
    },
    {
      name: 'isomorphic-domains-have-no-host-builtins',
      severity: 'error',
      comment: 'Shipped domain modules are isomorphic; test entrypoints run in the host test runner.',
      from: { path: '^packages/protocol-[^/]+/src/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'isomorphic-domain-dependencies-are-acyclic',
      severity: 'error',
      from: { path: '^packages/protocol-[^/]+/src/' },
      to: { circular: true },
    },
    {
      name: 'shared-platform-does-not-own-application-domains',
      severity: 'error',
      comment: 'Shared infrastructure may consume generic provider contracts, never tenant application behavior.',
      from: { path: '^packages/(?:platform|operator-worker)/src/' },
      to: { path: '^packages/(?:account-[^/]+/|core/|blocks/|protocol-(?:agent|environment|workspace)/|protocol/src/(?:index|rpc-contract|environment-contract|agent-activity|workspace-status|space-checkpoint|project-authority|inspector-contract|cron-contract|mcp-contract|skills-contract|user-settings)\\.ts$)' },
    },
    {
      name: 'no-legacy-product-dependencies',
      severity: 'error',
      comment: 'Current packages must not load the removed product or OMP runtime.',
      from: { path: '^packages/' },
      to: { path: '^(?:src/|web/|worker/|bin/gssh$|(?:node_modules/)?@oh-my-pi/)', pathNot: '^packages/' },
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    moduleSystems: ['es6'],
  },
};
