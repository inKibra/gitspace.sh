import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import React from 'react';
import { render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { NotePanel } from '../NotePanel.web.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

// The notes modal was superseded by NotePanel dock tabs (mock NoteView).
describe('NotePanel markdown preview', () => {
  it('renders a loaded note through the shared markdown renderer in preview mode', async () => {
    const backend = {
      listWorkspaceNotes: async () => [{
        id: 'note-1', body: '# Note title\n\n**Ship it**', kind: 'note' as const,
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }],
    } as unknown as import('../../session/backend.js').SessionBackend;
    const view = render(
      <NotePanel backend={backend} projectName="demo" workspaceName="ws" noteId="note-1" />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(view.container.innerHTML).toMatch(/<h1[^>]*>Note title<\/h1>/);
    expect(view.container.innerHTML).toContain('<strong>Ship it</strong>');
  });
});
