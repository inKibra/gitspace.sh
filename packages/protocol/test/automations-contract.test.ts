import { describe, expect, it } from 'bun:test';
import {
  describeAutomationSchedule,
  nextAutomationRunAt,
  parseAutomationSchedule,
  renderAutomationInstruction,
  unknownAutomationPlaceholders,
} from '../src/automations-contract.js';

const next = (expression: string, after: string) => new Date(nextAutomationRunAt(expression, Date.parse(after))).toISOString();

describe('automation schedules (UTC cron)', () => {
  it('runs strictly after the given time, on the next matching minute', () => {
    expect(next('0 6 * * *', '2026-10-27T05:59:30Z')).toBe('2026-10-27T06:00:00.000Z');
    expect(next('0 6 * * *', '2026-10-27T06:00:00Z')).toBe('2026-10-28T06:00:00.000Z');
    expect(next('30 */6 * * *', '2026-10-27T07:00:00Z')).toBe('2026-10-27T12:30:00.000Z');
  });

  it('matches day of month or day of week when both are restricted, and only the restricted one otherwise', () => {
    // 2026-10-27 is a Tuesday; the 1st of November is a Sunday, the 2nd a Monday.
    expect(next('0 0 1 * 1', '2026-10-27T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(next('0 0 * * 1', '2026-10-27T00:00:00Z')).toBe('2026-11-02T00:00:00.000Z');
    expect(next('0 0 1 * *', '2026-11-01T00:00:00Z')).toBe('2026-12-01T00:00:00.000Z');
  });

  it('treats 7 as Sunday and finds leap days', () => {
    expect(next('0 0 * * 7', '2026-10-27T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('refuses expressions that are malformed, out of range or never run', () => {
    for (const expression of ['0 6 * *', '61 * * * *', '5- * * * *', '*/0 * * * *', 'a * * * *', '0 0 30 2 *']) {
      expect('error' in parseAutomationSchedule(expression)).toBe(true);
    }
    expect(() => nextAutomationRunAt('0 0 31 4 *', 0)).toThrow('never runs');
  });

  it('reads common schedules back in words and others as the expression', () => {
    expect(describeAutomationSchedule('0 6 * * *')).toBe('Every day at 06:00 UTC');
    expect(describeAutomationSchedule('0 9 * * 1-5')).toBe('Weekdays at 09:00 UTC');
    expect(describeAutomationSchedule('0 16 * * 1,3')).toBe('Mondays and Wednesdays at 16:00 UTC');
    expect(describeAutomationSchedule('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeAutomationSchedule('15 * * * *')).toBe('Every hour at :15');
    expect(describeAutomationSchedule('0 0 1 * 1')).toBe('0 0 1 * 1 (UTC)');
  });
});

describe('automation instructions', () => {
  it('names the placeholders a trigger does not provide', () => {
    expect(unknownAutomationPlaceholders('Audit {{automation.name}} at {{ scheduled_for }} for {{pull_request.html_url}}', 'schedule')).toEqual(['pull_request.html_url']);
    expect(unknownAutomationPlaceholders('{{scheduled_for}}', 'manual')).toEqual(['scheduled_for']);
  });

  it('fills placeholders with the run values', () => {
    expect(renderAutomationInstruction('Run {{ automation.name }} at {{scheduled_for}}', { 'automation.name': 'Audit', scheduled_for: '06:00' })).toBe('Run Audit at 06:00');
  });
});
