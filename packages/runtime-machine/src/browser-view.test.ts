import { expect, test } from 'bun:test';
import { renderBrowserView } from './browser-view.js';

const node = (nodeId: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({ nodeId, role: { value: role }, name: { value: name }, ...extra });

test('a page reads as an outline in document order, with refs only on what can be acted on', () => {
  const lines = renderBrowserView([
    node('root', 'RootWebArea', 'Pulls', { childIds: ['layout', 'list', 'heading', 'form'], properties: [{ name: 'focusable', value: { value: true } }], backendDOMNodeId: 1 }),
    node('layout', 'LayoutTable', 'Open (4) | Closed', { childIds: ['row'] }),
    node('row', 'LayoutTableRow', 'Open (4) | Closed', { childIds: ['open', 'bar', 'closed'] }),
    node('open', 'link', 'Open (4)', { childIds: ['open-text', 'open-count'], backendDOMNodeId: 10 }),
    node('open-text', 'StaticText', 'Open', { childIds: ['open-inline'] }),
    node('open-inline', 'InlineTextBox', 'Open'),
    node('open-count', 'StaticText', '(4)'),
    node('bar', 'StaticText', '|'),
    node('closed', 'link', 'Closed', { backendDOMNodeId: 11 }),
    node('list', 'list', '', { childIds: ['item'] }),
    node('item', 'listitem', '', { childIds: ['meta'], properties: [{ name: 'level', value: { value: 1 } }] }),
    node('meta', 'generic', '', { childIds: ['hash', 'number', 'by', 'author'] }),
    node('hash', 'StaticText', '#'),
    node('number', 'StaticText', '98'),
    node('by', 'StaticText', 'by'),
    node('author', 'link', 'bradleat', { backendDOMNodeId: 12 }),
    node('heading', 'heading', '81 results', { childIds: ['heading-text'], properties: [{ name: 'level', value: { value: 3 } }], backendDOMNodeId: 13 }),
    node('heading-text', 'StaticText', '81 results'),
    node('form', 'group', 'Toppings', { childIds: ['bacon', 'send'] }),
    node('bacon', 'checkbox', 'Bacon', { backendDOMNodeId: 14, properties: [{ name: 'checked', value: { value: 'true' } }] }),
    node('send', 'button', 'Send', { backendDOMNodeId: 15, properties: [{ name: 'disabled', value: { value: true } }] }),
  ], 7);
  expect(lines.map(line => line.text)).toEqual([
    '- link "Open (4)" [ref=7:10]',
    '- link "Closed" [ref=7:11]',
    '- list:',
    '  - text: "98 by"',
    '  - link "bradleat" [ref=7:12]',
    '- heading "81 results" [level=3]',
    '- group "Toppings":',
    '  - checkbox "Bacon" [checked] [ref=7:14]',
    '  - button "Send" [disabled] [ref=7:15]',
  ]);
  expect(lines.flatMap(line => line.ref ? [line.ref] : [])).toEqual([10, 11, 12, 14, 15].map(id => ({ ref: `7:${id}`, backendNodeId: id })));
});
