import { describe, expect, test } from 'bun:test';
import { STAGED_CHOICE_DATA } from './session-controls.js';
import { commentsMessage, findTextQuote, messageComments, textQuoteAt, withoutComments, type SentComment } from './comments.js';

describe('a text-quote anchor', () => {
  const reply = 'Use KV for the session cache. KV keeps reads at the edge; D1 would add a hop. Use KV for flags too.';
  const start = reply.indexOf('Use KV for flags');
  const quote = textQuoteAt(reply, start, start + 'Use KV'.length);

  test('finds its own place among repeats of its text', () => {
    expect(findTextQuote(reply, quote)).toEqual({ start, end: start + 6 });
  });

  test('is found again after text changes elsewhere', () => {
    const edited = `Short answer first.\n\n${reply.replace('D1 would add a hop', 'D1 adds a network hop per read')}`;
    const found = findTextQuote(edited, quote);
    expect(found && edited.slice(found.start, found.end)).toBe('Use KV');
    expect(found && edited.slice(found.end)).toBe(' for flags too.');
  });

  test('is missing once its text is gone', () => {
    expect(findTextQuote(reply.replaceAll('Use KV', 'Use D1'), quote)).toBeNull();
  });
});

describe('comments in a message', () => {
  const comment: SentComment = {
    id: 'cm-0123456789ab', note: 'Why not D1?\nIt is already bound.',
    anchor: { document: { kind: 'turn', conversationId: '1', turnId: 'pi:1:turn:1024' }, target: { kind: 'block', id: 'pi:1:turn:1024:message:2048:0#cache' }, quote: 'Cache choice' },
  };

  test('travel as a line and its data after the person\'s text, which people read without them', () => {
    const message = commentsMessage('Thanks.', [comment]);
    expect(message.startsWith('Thanks.\n\nComment on “Cache choice”: Why not D1? It is already bound.\n~~~json\n')).toBe(true);
    expect(messageComments(message)).toEqual([comment]);
    expect(withoutComments(message)).toBe('Thanks.');
    // Where a message is quoted (a journal citation), the line stays and its data goes.
    expect(message.replace(STAGED_CHOICE_DATA, '$1')).toBe('Thanks.\n\nComment on “Cache choice”: Why not D1? It is already bound.');
  });
});
