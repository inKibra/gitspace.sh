import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginsPage } from './PluginsPage.js';

const noop = async () => undefined;

describe('PluginsPage', () => {
  it('separates principal connections from project grants and shows discovered OMP tools', () => {
    const now = new Date();
    const html = renderToStaticMarkup(<PluginsPage
      projectId="project-a"
      projectName="GitSpace"
      projects={[{ id: 'project-a', name: 'GitSpace' }]}
      connections={[{
        principalId: 'principal-a', id: 'paper', label: 'Paper Desktop', enabled: true,
        target: { kind: 'machine', machineId: 'machine-a' }, transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp', headers: [] }, timeoutMs: 30_000,
        status: 'ready', statusMessage: null, statusCheckedAt: now, serverFingerprint: 'sha256:test', serverVersion: '1.0.0', revision: 1, createdAt: now, updatedAt: now,
      }]}
      grants={[{ projectId: 'project-a', connectionId: 'paper', enabled: true, projectSpaceEnabled: true, workspacesEnabled: true, revision: 1, createdBy: 'machine-a', createdAt: now, updatedAt: now }]}
      tools={[{ connectionId: 'paper', connectionLabel: 'Paper Desktop', serverName: 'gitspace-paper', name: 'create_rectangle', ompToolName: 'mcp__gitspace-paper__create_rectangle', description: 'Create a rectangle', inputSchema: {}, outputSchema: null, readOnly: false, destructive: false, idempotent: false, openWorld: false }]}
      machines={[{ id: 'machine-a', label: 'Studio', state: 'online' }]}
      onCreate={noop}
      onUpdate={noop}
      onDelete={noop}
      onSetGrant={noop}
      onRefresh={noop}
    />);
    expect(html).toContain('Paper Desktop');
    expect(html).toContain('Studio');
    expect(html).toContain('ready');
    expect(html).toContain('1 discovered tool');
    expect(html).toContain('Manage access');
    expect(html).not.toContain('header-secret-value');
  });

  it('renders an honest empty connection state', () => {
    const html = renderToStaticMarkup(<PluginsPage projectId="project-a" projectName="GitSpace" projects={[{ id: 'project-a', name: 'GitSpace' }]} connections={[]} grants={[]} tools={[]} machines={[]} onCreate={noop} onUpdate={noop} onDelete={noop} onSetGrant={noop} onRefresh={noop} />);
    expect(html).toContain('No plugins connected');
    expect(html).toContain('Add the first connection');
  });
});
