import { describe, expect, it } from 'vitest';
import { matchesModelQuery, modelOptions } from './ModelCombobox.js';

describe('model search', () => {
  const [sonnet, astra] = modelOptions([
    { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { provider: 'openai-codex', id: 'gpt-6-astra', name: 'GPT-6-Astra' },
  ]);

  it('requires every word to match across name, id and provider, in any case', () => {
    expect(matchesModelQuery(sonnet!, 'BEDROCK sonnet')).toBe(true);
    expect(matchesModelQuery(sonnet!, 'us.anthropic')).toBe(true);
    expect(matchesModelQuery(astra!, 'bedrock astra')).toBe(false);
    expect(matchesModelQuery(astra!, '  codex   astra ')).toBe(true);
  });
});
