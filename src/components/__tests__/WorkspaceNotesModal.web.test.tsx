import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import React from 'react';
import { render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { WorkspaceNotesModal } from '../WorkspaceNotesModal.web.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

describe('WorkspaceNotesModal markdown preview', () => {
  it('renders markdown through the shared renderer in preview mode', () => {
    const view = render(
      <WorkspaceNotesModal
        workspaceName="demo"
        notes={[{ id: 'note-1', body: '# Note title\n\n**Ship it**', updatedAt: new Date(0).toISOString() }]}
        selectedNoteId="note-1"
        draftBody={'# Note title\n\n**Ship it**'}
        onSelectNote={() => undefined}
        onChangeDraftBody={() => undefined}
        onAddNote={() => undefined}
        onSaveNote={() => undefined}
        onDeleteNote={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(view.container.innerHTML).toMatch(/<h1[^>]*>Note title<\/h1>/);
    expect(view.container.innerHTML).toContain('<strong>Ship it</strong>');
  });
});
