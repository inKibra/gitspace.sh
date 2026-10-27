import { describe, expect, it } from 'bun:test';
import { restoredGroup, restoredMembers } from '../src/commands.js';

const name = 'gitspace · checkout';

describe('the group a workspace adopts after Chrome restarts', () => {
  it('is the one group with the workspace group name and colour', () => {
    expect(restoredGroup([{ id: 4, title: 'other', color: 'blue' }, { id: 7, title: name, color: 'red' }, { id: 9, title: name, color: 'blue' }], name, 'blue', [])).toBe(9);
  });
  it('is none when no group matches or several do', () => {
    expect(restoredGroup([{ id: 4, title: 'other', color: 'blue' }, { id: 7, title: name, color: 'red' }], name, 'blue', [])).toBeNull();
    expect(restoredGroup([{ id: 4, title: name, color: 'blue' }, { id: 7, title: name, color: 'blue' }], name, 'blue', [])).toBeNull();
  });
  it('is never a group another workspace holds, and the other match is then the only one', () => {
    expect(restoredGroup([{ id: 4, title: name, color: 'blue' }], name, 'blue', [4])).toBeNull();
    expect(restoredGroup([{ id: 4, title: name, color: 'blue' }, { id: 7, title: name, color: 'blue' }], name, 'blue', [4])).toBe(7);
  });
  it('after an extension reload is the record’s own group while it keeps the name and colour, even beside another group sharing them', () => {
    expect(restoredGroup([{ id: 4, title: name, color: 'blue' }, { id: 7, title: name, color: 'blue' }], name, 'blue', [], 7)).toBe(7);
    // Renamed or recoloured, or held by another workspace, it is not the workspace's group any more.
    expect(restoredGroup([{ id: 4, title: 'renamed', color: 'blue' }, { id: 7, title: name, color: 'blue' }], name, 'blue', [], 4)).toBe(7);
    expect(restoredGroup([{ id: 4, title: name, color: 'blue' }, { id: 7, title: name, color: 'blue' }], name, 'blue', [7], 7)).toBe(4);
  });
});

describe('the tabs of an adopted group', () => {
  it('each count as one you dragged in, consenting to the site it shows', () => {
    expect(restoredMembers([{ id: 11, url: 'https://app.example/inbox' }, { id: 12, url: 'about:blank' }, { id: 13, url: 'chrome://settings' }, { id: 14 }, { url: 'https://lost.example/' }])).toEqual({
      11: { by: 'you', site: 'app.example' },
      12: { by: 'you', site: null },
      13: { by: 'you', site: null },
      14: { by: 'you', site: null },
    });
  });
  it('keep what the record knew of tabs still in the group, after an extension reload', () => {
    expect(restoredMembers([{ id: 11, url: 'https://dash.example/' }, { id: 12, url: 'about:blank' }], { 11: { by: 'you', site: 'dash.example' }, 12: { by: 'agent', site: null }, 99: { by: 'you', site: 'gone.example' } })).toEqual({
      11: { by: 'you', site: 'dash.example' },
      12: { by: 'agent', site: null },
    });
  });
});
