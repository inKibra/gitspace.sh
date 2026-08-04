import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dashboardSchema, reportSchema } from '../artifact-envelopes.js';
import { parseJsonWith, parseWith } from '../schema-parse.js';

const skillPath = join(import.meta.dir, '../../lib/tmux-lite/agents/skills/space-artifacts/SKILL.md');

function sectionBetween(skill: string, startMarker: string, endMarker: string): string {
  const start = skill.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Skill section marker not found: ${startMarker}`);
  }
  const end = skill.indexOf(endMarker, start + startMarker.length);
  return skill.slice(start, end >= 0 ? end : skill.length);
}


/** Remove comments without treating // inside a quoted JSON string as a comment. */
function stripJsonComments(raw: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const next = raw[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && next === '/') {
      index += 1;
      while (index + 1 < raw.length && raw[index + 1] !== '\n' && raw[index + 1] !== '\r') {
        index += 1;
      }
    } else if (char === '/' && next === '*') {
      index += 2;
      while (index + 1 < raw.length && !(raw[index] === '*' && raw[index + 1] === '/')) {
        index += 1;
      }
      if (index + 1 < raw.length) index += 1;
    } else {
      output += char;
    }
  }

  return output;
}


describe('artifact envelope skill schema drift sentinels', () => {
  const skill = readFileSync(skillPath, 'utf8');

  it('validates every fenced Dashboard JSON example against the canonical schema', () => {
    const examples = [...sectionBetween(skill, '**Dashboard**', '**Report**').matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(examples.length).toBeGreaterThan(0);

    for (const [index, raw] of examples.entries()) {
      const parsed = parseJsonWith(dashboardSchema, stripJsonComments(raw));
      if (!parsed.ok) {
        throw new Error(`Dashboard skill example ${index + 1} failed schema validation:\n${parsed.issues.join('\n')}\n${raw}`);
      }
    }
  });

  it('validates every fenced Report JSON example against the canonical schema after removing comments', () => {
    const examples = [...sectionBetween(skill, '**Report**', '**Trigger**').matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(examples.length).toBeGreaterThan(0);

    for (const [index, raw] of examples.entries()) {
      const parsed = parseJsonWith(reportSchema, stripJsonComments(raw));
      if (!parsed.ok) {
        throw new Error(`Report skill example ${index + 1} failed schema validation:\n${parsed.issues.join('\n')}\n${raw}`);
      }
    }
  });
});

describe('artifact envelope parse diagnostics', () => {
  it('returns field-level issues for malformed reports', () => {
    const result = parseWith(reportSchema, {
      kind: 'not-a-report-kind',
      surface: 123,
      note: null,
      rating: 6,
    });

    if (result.ok) throw new Error('Expected malformed report to fail schema validation');
    expect(result.issues.map((issue) => issue.slice(0, issue.indexOf(': '))).sort()).toEqual(['kind', 'surface', 'note', 'rating'].sort());
  });

  it('points to the nested app field for malformed dashboard panels', () => {
    const result = parseWith(dashboardSchema, {
      panels: [{ app: 123 }],
    });

    if (result.ok) throw new Error('Expected malformed dashboard to fail schema validation');
    expect(result.issues.map((issue) => issue.slice(0, issue.indexOf(': '))).sort()).toEqual(['panels.0.id', 'panels.0.app', 'panels.0.title'].sort());
  });
});
