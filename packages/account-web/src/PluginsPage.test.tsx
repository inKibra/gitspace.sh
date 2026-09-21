import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginsPage } from './PluginsPage.js';

const noop = async () => undefined;
const composioProps = {
  composioCatalog: { configured: true, toolkits: [] },
  onAuthorizeComposio: async () => 'https://connect.composio.dev/test',
  onRefreshComposio: noop,
  onLoadComposioTools: async () => [],
  onUpdateComposioTools: noop,
  onDisconnectComposio: noop,
  onDiscover: async () => [],
  onRevokeGrant: noop,
} as const;

describe('PluginsPage', () => {
  it('renders account connections and their machine targets independently of runtime discovery', () => {
    const now = new Date();
    const html = renderToStaticMarkup(<PluginsPage
      projects={[{ id: 'project-a', name: 'GitSpace' }]}
      connections={[{
        principalId: 'principal-a', id: 'paper', label: 'Paper Desktop', enabled: true,
        target: { kind: 'machine', machineId: 'machine-a' }, transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp', headers: [] }, timeoutMs: 30_000,
        status: 'ready', statusMessage: null, statusCheckedAt: now, serverFingerprint: 'sha256:test', serverVersion: '1.0.0', revision: 1, createdAt: now, updatedAt: now,
      }]}
      grants={[{ projectId: 'project-a', connectionId: 'paper', enabled: true, projectSpaceEnabled: true, workspacesEnabled: true, revision: 1, createdBy: 'machine-a', createdAt: now, updatedAt: now }]}
      machines={[{ id: 'machine-a', label: 'Studio', state: 'online' }]}
      {...composioProps}
      onCreate={noop}
      onUpdate={noop}
      onDelete={noop}
      onSetGrant={noop}
      onRefresh={noop}
    />);
    expect(html).toContain('Paper Desktop');
    expect(html).toContain('Studio');
    expect(html).toContain('ready');
    expect(html).toContain('Manage plugin');
    expect(html).not.toContain('header-secret-value');
  });


  it('renders connected and available Composio plugins as plugins', () => {
    const now = new Date();
    const html = renderToStaticMarkup(<PluginsPage
      {...composioProps}
      composioCatalog={{ configured: true, toolkits: [{ slug: 'github', name: 'GitHub', description: 'Manage GitHub work', logoUrl: null, toolsCount: 42 }] }}
      projects={[{ id: 'project-a', name: 'GitSpace' }]}
      connections={[{
        principalId: 'principal-a', id: 'composio-github-a', label: 'Work GitHub', enabled: true,
        target: { kind: 'cloud' }, transport: { type: 'composio', toolkit: 'github', connectedAccountId: 'ca_test', allowedTools: ['GITHUB_SEARCH_ISSUES'] }, timeoutMs: 30_000,
        status: 'ready', statusMessage: null, statusCheckedAt: now, serverFingerprint: null, serverVersion: null, revision: 2, createdAt: now, updatedAt: now,
      }]}
      grants={[]}
      machines={[]}
      onCreate={noop}
      onUpdate={noop}
      onDelete={noop}
      onSetGrant={noop}
      onRefresh={noop}
    />);
    expect(html).toContain('Work GitHub');
    expect(html).toContain('1 allowed tool');
    expect(html).toContain('Manage plugin');
    expect(html).toContain('GitHub');
    expect(html).not.toContain('Integration');
  });
});
