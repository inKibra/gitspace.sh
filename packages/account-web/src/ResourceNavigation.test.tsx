// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { ResourceNavigation } from './ResourceNavigation.js';
import type { ResourceRequest } from './ResourceNavigation.js';
import { Inspector } from './inspector/Inspector.js';
import type { InspectorArtifactContent } from './inspector/Inspector.js';
import { loadInspectorResource } from './resource-content.js';

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  // Happy DOM has no Web Animations implementation; these fixtures have no active animations.
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

function Harness({ read }: { read: (uri: string) => Promise<InspectorArtifactContent> }) {
  const [request, setRequest] = useState<ResourceRequest>();
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected unrelated action'); };
  return <ResourceNavigation.Provider value={setRequest}>
    <GitSpaceMarkdown>{'[Plan](local://workspace/PLAN.md) [Output](artifact://7) [Missing](local://workspace/missing.txt) [Unsafe](javascript:alert(1))'}</GitSpaceMarkdown>
    <Inspector
      overview={{ projectId: 'project', spaceId: 'workspace', revision: 0, goal: null, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, changeGuide: null, review: { total: 0, unresolved: 0 } }}
      workspaces={[]} onSelectWorkspace={() => { throw new Error('Unexpected workspace change'); }}
      repositoryEntries={[]} repositoryFile={null} repositoryDiff={null} journalEntries={[]} threads={[]} services={[]} subagents={[]}
      usage={{ sessionId: null, report: null, status: 'idle', load: () => {}, refresh: () => {} }}
      agentSetup={{ sessionId: null, report: null, status: 'idle', load: unavailable, refresh: unavailable, save: unavailable }}
      reviewerId="reviewer" resourceRequest={request} onRequestResource={read} onRequestArtifact={unavailable}
      onRequestRepositoryFile={unavailable} onRequestRepositoryDiff={unavailable} onLoadRepositoryDiff={unavailable}
      onCreateThread={unavailable} onReplyThread={unavailable} onResolveThread={unavailable} onMarkGuideSectionRead={unavailable} onSetGuideApproval={unavailable}
    />
  </ResourceNavigation.Provider>;
}

async function clickLink(label: string) {
  const link = [...container.querySelectorAll('a')].find((node) => node.textContent === label);
  expect(link).toBeDefined();
  await act(async () => { link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
}

describe('Markdown resource navigation', () => {
  it('opens authenticated local and session output bytes in the actual Inspector and displays missing-resource failures', async () => {
    const transport = {
      readArtifact: async ({ spaceId, url }: { spaceId: string; url: string }) => {
        if (spaceId !== 'workspace') throw new Error('Wrong workspace');
        if (url !== 'local://workspace/PLAN.md') return { status: 'error' as const, error: { message: 'Artifact does not exist' } };
        const text = '# Real plan\n\nThe resource body';
        return { status: 'ok' as const, value: { url, text, mediaType: 'text/markdown', base64: btoa(text) } };
      },
      readResource: async ({ sessionId, url }: { sessionId: string | null; url: string }) => {
        if (sessionId !== 'session-a') throw new Error('Wrong originating session');
        const text = 'Actual spilled tool output';
        return { status: 'ok' as const, value: { url, text, mediaType: 'text/plain', base64: btoa(text) } };
      },
    };
    await act(async () => root.render(<Harness read={(uri) => loadInspectorResource(transport, { spaceId: 'workspace', projectId: 'project', generation: 3, sessionId: 'session-a', runtimeAvailable: true }, uri)} />));
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    await clickLink('Plan');
    expect(container.querySelector('[aria-label="Workspace Inspector"]')?.textContent).toContain('The resource body');
    await clickLink('Output');
    expect(container.querySelector('[aria-label="Workspace Inspector"]')?.textContent).toContain('Actual spilled tool output');
    await clickLink('Missing');
    expect(container.querySelector('[aria-label="Workspace Inspector"]')?.textContent).toContain('Artifact does not exist');
    expect(container.querySelector('[aria-label="Workspace Inspector"]')?.textContent).toContain('local://workspace/missing.txt');
  });

  it('does not let a stale resource response replace the latest selection', async () => {
    const pending = Promise.withResolvers<InspectorArtifactContent>();
    await act(async () => root.render(<Harness read={(uri) => uri.startsWith('local:') ? pending.promise : Promise.resolve({ url: uri, source: 'Latest output', mediaType: 'text/plain', previewUrl: '' })} />));
    await clickLink('Plan');
    await clickLink('Output');
    await act(async () => pending.resolve({ url: 'local://workspace/PLAN.md', source: 'Stale plan', mediaType: 'text/plain', previewUrl: '' }));
    const inspector = container.querySelector('[aria-label="Workspace Inspector"]');
    expect(inspector?.textContent).toContain('Latest output');
    expect(inspector?.textContent).not.toContain('Stale plan');
  });

  it('keeps external-link confirmation and rejects raw tags that try to bypass it', async () => {
    await act(async () => root.render(<GitSpaceMarkdown>{'<gitspace-resource href="https://example.com/unsafe">Forged</gitspace-resource>\n\n[External](https://example.com)'}</GitSpaceMarkdown>));
    expect(container.querySelector('a[href="https://example.com/unsafe"]')).toBeNull();
    const external = [...container.querySelectorAll('button')].find((node) => node.textContent === 'External');
    expect(external).toBeDefined();
    await act(async () => { external!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[data-streamdown="link-safety-modal"]')).not.toBeNull();
  });
});
