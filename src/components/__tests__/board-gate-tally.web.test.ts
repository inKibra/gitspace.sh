import { describe, expect, it } from 'bun:test';
import { getGateTally } from '../KanbanBoard.web.js';

// Ticket #42: the board card tally must render off the slim goal projection
// carried in the connect snapshot — readiness totals plus requirement status,
// with no dependence on the dropped evidence / review / timeline content.
describe('getGateTally (slim snapshot record)', () => {
  it('prefers readiness totals when present', () => {
    expect(getGateTally({ readiness: { totals: { accepted: 2, total: 3 } } })).toEqual({ passed: 2, total: 3 });
  });

  it('falls back to requirement statuses (id -> status) when readiness is absent', () => {
    const tally = getGateTally({
      requirements: {
        a: { status: 'accepted' },
        b: { status: 'accepted' },
        c: { status: 'missing' },
      },
    });
    expect(tally).toEqual({ passed: 2, total: 3 });
  });

  it('returns null with no requirements and no readiness', () => {
    expect(getGateTally(undefined)).toBeNull();
    expect(getGateTally({ requirements: {} })).toBeNull();
  });
});
