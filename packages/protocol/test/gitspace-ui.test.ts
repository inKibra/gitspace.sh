import { describe, expect, it } from 'bun:test';
import { extractBlocks, parseSvg, UI_BLOCK_EXAMPLES, uiBlockPrompt, validateMarkdownBlocks, validateSvg, validateUiSpec } from '../src/gitspace-ui.js';

const fence = '```';

function reviewSpec(): { root: string; elements: Record<string, Record<string, unknown>>; state: Record<string, unknown> } {
  return {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Open review threads', eyebrow: null }, children: ['count', 'threads', 'staged'], slots: { footer: ['send'] } },
      count: { type: 'Text', props: { text: { $computed: 'progress', args: { items: { $state: '/threads' }, field: 'include', noun: 'threads' } }, tone: 'muted' }, children: [] },
      threads: { type: 'Checklist', props: { title: null }, repeat: { statePath: '/threads', key: 'id' }, children: ['thread'] },
      thread: { type: 'ChecklistItem', props: { index: { $index: true }, label: { $template: '${path}:${line}' }, checked: { $bindItem: 'include' }, note: { $item: 'body' } }, children: [] },
      staged: { type: 'Badge', visible: [{ $state: '/staged/review' }, { $state: '/sent/review', not: true }], props: { label: 'staged', color: 'amber', variant: 'dot' }, children: [] },
      send: {
        type: 'Button',
        props: { label: 'Add to message', variant: { $cond: { $state: '/threads/0/include' }, $then: 'primary', $else: 'secondary' } },
        on: { press: { action: 'stage', params: { kind: 'review', label: 'threads', payload: { threads: { $computed: 'where', args: { items: { $state: '/threads' }, field: 'include' } } } } } },
        children: [],
      },
    },
    state: { threads: [{ id: 't1', path: 'src/a.ts', line: 4, body: 'Rename this', include: true }] },
  };
}

const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path);

describe('gitspace-ui specs', () => {
  it('accepts a spec that uses repeat, slots, visibility and every expression form', () => {
    expect(validateUiSpec(reviewSpec())).toEqual([]);
  });

  it('accepts every example the skill teaches, each drawn as its own block', () => {
    const prompt = uiBlockPrompt();
    expect(validateMarkdownBlocks(prompt)).toEqual([]);
    expect(extractBlocks(prompt).map((block) => block.kind)).toEqual(UI_BLOCK_EXAMPLES.map((example) => example.fence));
  });

  it('rejects a FlowMap whose paths or steps name areas or paths it does not have', () => {
    const map = (props: Record<string, unknown>) => validateUiSpec({ root: 'map', elements: { map: { type: 'FlowMap', props, children: [] } }, state: {} });
    const areas = [{ id: 'web', name: 'Web app', group: 'account-web' }, { id: 'worker', name: 'Worker', group: 'account-worker' }];
    expect(map({ areas, paths: [{ id: 'send', from: 'web', to: 'worker', label: 'message', state: 'added' }], steps: [{ paths: ['send'], from: 'web', to: 'worker', caption: 'Sent.' }] })).toEqual([]);
    expect(paths(map({
      areas: [...areas, { id: 'web', name: 'Again', group: 'account-web' }],
      paths: [{ id: 'send', from: 'web', to: 'db', label: 'write', state: 'added' }, { id: 'send', from: 'worker', to: 'web', label: 'reply', state: 'same' }],
      steps: [{ paths: ['send', 'gone'], from: 'nowhere', to: 'worker', caption: 'Sent.' }],
    }))).toEqual(['/elements/map/props/areas/2/id', '/elements/map/props/paths/0/to', '/elements/map/props/paths/1/id', '/elements/map/props/steps/0/from', '/elements/map/props/steps/0/paths/1']);
  });

  it('rejects a missing root, a root that names no element, missing elements and missing children', () => {
    expect(paths(validateUiSpec({ root: 'card' }))).toEqual(['/elements']);
    const noRoot = reviewSpec();
    expect(paths(validateUiSpec({ elements: noRoot.elements, state: noRoot.state }))).toEqual(['/root']);
    expect(paths(validateUiSpec({ ...reviewSpec(), root: 'nothing' }))).toEqual(['/root']);
    const spec = reviewSpec();
    spec.elements.card.children = ['count', 'gone', 'threads', 'staged'];
    spec.elements.card.slots = { footer: ['send', 'also-gone'] };
    expect(paths(validateUiSpec(spec))).toEqual(['/elements/card/children/1', '/elements/card/slots/footer/1']);
    const withoutChildren = reviewSpec();
    delete withoutChildren.elements.count.children;
    expect(paths(validateUiSpec(withoutChildren))).toEqual(['/elements/count/children']);
  });

  it('rejects an element that contains itself', () => {
    const spec = reviewSpec();
    spec.elements.thread = { type: 'Stack', props: {}, children: ['threads'] };
    expect(paths(validateUiSpec(spec))).toEqual(['/elements/thread/children/0']);
  });

  it('rejects unknown components, props and actions', () => {
    const spec = reviewSpec();
    spec.elements.count = { type: 'Carousel', props: {}, children: [] };
    spec.elements.staged.props = { label: 'staged', colour: 'amber' };
    spec.elements.send.on = { press: { action: 'delete_branch', params: {} } };
    expect(paths(validateUiSpec(spec))).toEqual(['/elements/count/type', '/elements/staged/props/colour', '/elements/send/on/press/action']);
  });

  it('checks literal prop and param values against the catalog, including missing required props', () => {
    const spec = reviewSpec();
    spec.elements.count = { type: 'Table', props: { columns: [{ key: 'ms', label: 'ms', align: 'center' }], rows: [] }, children: [] };
    spec.elements.staged = { type: 'Chart', props: { unit: 'ms', series: [{ key: 'p50', label: 'p50', color: '#ff0000' }], rows: [] }, children: [] };
    spec.elements.thread.props = { index: { $index: true }, checked: { $bindItem: 'include' } };
    spec.elements.send.on = { press: { action: 'stage', params: { kind: 'vote', label: 'threads' } } };
    expect(paths(validateUiSpec(spec))).toEqual([
      '/elements/count/props/columns/0/align',
      '/elements/thread/props/label',
      '/elements/staged/props/series/0/color',
      '/elements/send/on/press/params/kind',
    ]);
  });

  it('accepts expressions in place of values but checks $cond branches and $computed names', () => {
    const spec = reviewSpec();
    spec.elements.count = { type: 'Table', props: { columns: [{ key: 'ms', label: 'ms', align: { $cond: { $state: '/threads/0/include' }, $then: 'right', $else: 'center' } }], rows: { $state: '/threads' } }, children: [] };
    spec.elements.staged.props = { label: { $computed: 'sum', args: { items: { $state: '/threads' } } } };
    expect(paths(validateUiSpec(spec))).toEqual(['/elements/count/props/columns/0/align/$else', '/elements/staged/props/label/$computed']);
  });

  it('rejects state reads the seeded state cannot answer, except the roots GitSpace writes', () => {
    const spec = reviewSpec();
    spec.elements.count.props = { text: { $state: '/summary' } };
    spec.elements.staged.visible = { $state: '/tab', eq: 'all' };
    spec.elements.threads.repeat = { statePath: '/rows', key: 'id' };
    expect(paths(validateUiSpec(spec))).toEqual(['/elements/count/props/text/$state', '/elements/threads/repeat/statePath', '/elements/staged/visible/$state']);
    const owned = reviewSpec();
    owned.elements.count.props = { text: { $state: '/answered' } };
    owned.elements.staged.visible = [{ $state: '/staged/q1' }, { $state: '/sent/q1', not: true }, { $state: '/gitspaceNotices/0' }];
    expect(validateUiSpec(owned)).toEqual([]);
  });

  it('rejects specs over the element limit', () => {
    const spec = reviewSpec();
    for (let index = 0; index < 251; index += 1) spec.elements[`extra-${index}`] = { type: 'Text', props: { text: 'x' }, children: [] };
    expect(paths(validateUiSpec(spec))).toEqual(['/elements']);
  });
});

describe('SVG drawings', () => {
  const themed = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><defs><marker id="arrow"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>'
    + '<line x1="0" y1="10" x2="30" y2="10" stroke="var(--muted-foreground)" marker-end="url(#arrow)"/><text x="2" y="8" style="fill: var(--foreground)">a &amp; b</text><use href="#arrow"/></svg>';

  it('accepts a themed drawing with local references', () => {
    expect(validateSvg(themed)).toEqual([]);
  });

  it('rejects scripts, foreignObject, event handlers, external links and literal colours', () => {
    expect(paths(validateSvg('<svg><script>alert(1)</script></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><foreignObject><div/></foreignObject></svg>'))).toEqual(['/0', '/0/0']);
    expect(paths(validateSvg('<svg><rect onclick="alert(1)" fill="none"/></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><use href="https://example.com/a.svg#x"/></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><use xlink:href="&#106;avascript:alert(1)"/></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><rect fill="url(https://example.com/p.svg#g)"/></svg>'))).toHaveLength(2);
    expect(paths(validateSvg('<svg><circle r="2" fill="#ff0000"/></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg/><svg/>'))).toEqual(['']);
  });

  it('refuses markup an HTML parser reads differently from the validator', () => {
    const refused = [
      '<svg viewBox="0 0 10 10"><!-- --!><img src=x onerror=alert(1)> --></svg>',
      '<svg viewBox="0 0 10 10"><!--><img src=x onerror=alert(1)>--></svg>',
      '<svg viewBox="0 0 10 10"><!---><img src=x onerror=alert(1)>--></svg>',
      '<svg viewBox="0 0 10 10"><!-- a note --></svg>',
      '<svg viewBox="0 0 10 10"><![CDATA[<img src=x onerror=alert(1)>]]></svg>',
      '<!DOCTYPE svg><svg viewBox="0 0 10 10"/>',
      '<svg viewBox="0 0 10 10"><?pi <img src=x onerror=alert(1)> ?></svg>',
      '<?xml version="1.0"?><?xml-stylesheet href="https://example.com/x.css"?><svg viewBox="0 0 10 10"/>',
      '<svg viewBox="0 0 10 10"></svg><img src=x onerror=alert(1)>',
      '<svg viewBox="0 0 10 10"></svg>trailing',
      '<SVG viewBox="0 0 10 10"></SVG>',
      '<svg viewBox="0 0 10 10"><Script>alert(1)</Script></svg>',
      '<svg viewBox="0 0 10 10"><svg:script>alert(1)</svg:script></svg>',
      '<svg viewBox="0 0 10 10"><title><img src=x onerror=alert(1)></title></svg>',
      '<svg viewBox="0 0 10 10"><rect/onload="alert(1)"/></svg>',
      '<svg viewBox="0 0 10 10"><rect o&#110;load="alert(1)"/></svg>',
      '<svg viewBox="0 0 10 10"><rect width=10 onload=alert(1) /></svg>',
      '<svg viewBox="0 0 10 10"><rect ONLOAD="alert(1)"/></svg>',
      '<svg viewBox="0 0 10 10"><rect style="fill: none; mask: u\\72l(https://example.com/m)"/></svg>',
      '<svg viewBox="0 0 10 10"><rect style="mask-image: image-set(\'https://example.com/m.png\' 1x)"/></svg>',
    ];
    expect(refused.filter((svg) => validateSvg(svg).length === 0)).toEqual([]);
  });

  it('parses the tree a renderer draws: decoded attributes and text, nothing else', () => {
    const { root, issues } = parseSvg('<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 10 10"><rect id="a>b" fill="none"/><text>&lt;img src=x onerror=alert(1)&gt; &amp; more</text></svg>');
    expect(issues).toEqual([]);
    expect(root).toEqual({ name: 'svg', attributes: [['viewBox', '0 0 10 10']], children: [
      { name: 'rect', attributes: [['id', 'a>b'], ['fill', 'none']], children: [] },
      { name: 'text', attributes: [], children: ['<img src=x onerror=alert(1)> & more'] },
    ] });
  });

  it('applies the same rules to the Svg component', () => {
    const spec = reviewSpec();
    spec.elements.count = { type: 'Svg', props: { svg: '<svg><g><script/></g></svg>' }, children: [] };
    expect(paths(validateUiSpec(spec))).toEqual(['/elements/count/props/svg/0/0']);
  });
});

describe('Markdown blocks', () => {
  it('extracts only exact gitspace-ui, svg and mermaid fences, skipping fences inside other code blocks', () => {
    const markdown = `Intro\n${fence}svg title\n<svg/>\n${fence}\n\n${fence}${fence}markdown\n${fence}mermaid\n\n${fence}\n${fence}${fence}\n\n~~~mermaid\ngraph TD; A-->B\n~~~\n`;
    expect(extractBlocks(markdown).map((block) => [block.kind, block.body, markdown.slice(block.start, block.end)])).toEqual([
      ['mermaid', 'graph TD; A-->B', '~~~mermaid\ngraph TD; A-->B\n~~~'],
    ]);
  });

  it('reports an unclosed fence and an empty mermaid block', () => {
    expect(validateMarkdownBlocks(`Look:\n${fence}gitspace-ui\n${JSON.stringify(reviewSpec())}\n`)).toEqual([{ path: 'block 1', message: 'the ```gitspace-ui fence is not closed' }]);
    expect(paths(validateMarkdownBlocks(`${fence}mermaid\n  \n${fence}`))).toEqual(['block 1']);
  });

  it('prefixes each issue path with its block number and escapes element keys as JSON pointers', () => {
    const spec = reviewSpec();
    spec.elements['a/b~c'] = { type: 'Text', props: { text: 'x', size: 'huge' }, children: [] };
    spec.elements.card.children = ['a/b~c', 'missing'];
    const markdown = `One:\n${fence}svg\n<svg><path d="M0 0" stroke="var(--border)"/></svg>\n${fence}\nTwo:\n${fence}gitspace-ui\n${JSON.stringify(spec)}\n${fence}\nThree:\n${fence}gitspace-ui\n{"root":\n${fence}\n`;
    expect(paths(validateMarkdownBlocks(markdown))).toEqual(['block 2/elements/card/children/1', 'block 2/elements/a~1b~0c/props/size', 'block 3']);
  });
});
