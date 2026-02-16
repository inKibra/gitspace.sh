import { describe, expect, it } from 'bun:test';
import { buildSessionName } from '../session-name.js';

describe('buildSessionName', () => {
  it('returns first available numeric suffix for auto naming', () => {
    const name = buildSessionName({
      projectName: 'alpha',
      workspaceName: 'ws-1',
      sessions: [
        { name: 'alpha:ws-1:1' },
        { name: 'alpha:ws-1:3' },
        { name: 'alpha:ws-2:1' },
      ],
    });

    expect(name).toBe('alpha:ws-1:2');
  });

  it('throws when requested name already exists in workspace', () => {
    try {
      buildSessionName({
        projectName: 'alpha',
        workspaceName: 'ws-1',
        requestedName: 'debug',
        sessions: [{ name: 'alpha:ws-1:debug' }],
      });
      expect.unreachable('Expected duplicate session name error');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'SessionNameExistsError',
        code: 'SESSION_ALREADY_EXISTS',
      });
    }
  });
});
