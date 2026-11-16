import { describe, expect, it } from 'bun:test';
import { extractBlocks, fenceSpec, mapBlockColours, parseSvg, requiredBlockAsks, themeColour, UI_BLOCK_BRIEF, UI_BLOCK_EXAMPLES, uiBlockPrompt, validateMarkdownBlocks, validateSvg, validateUiSpec } from '../src/gitspace-ui.js';

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
    expect(extractBlocks(prompt).map((block) => [block.kind, block.info].filter(Boolean).join(' '))).toEqual(UI_BLOCK_EXAMPLES.map((example) => example.fence));
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

  it('rejects scripts, foreignObject, event handlers and external links, with literal colours in them or not', () => {
    expect(paths(validateSvg('<svg><script>alert(1)</script></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><foreignObject><div/></foreignObject></svg>'))).toEqual(['/0', '/0/0']);
    expect(paths(validateSvg('<svg><rect onclick="alert(1)" fill="none"/></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><use href="https://example.com/a.svg#x"/></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><use xlink:href="&#106;avascript:alert(1)"/></svg>'))).toEqual(['/0']);
    expect(paths(validateSvg('<svg><rect fill="url(https://example.com/p.svg#g)"/></svg>'))).toHaveLength(2);
    expect(paths(validateSvg('<svg><circle r="2" fill="#ff0000" onclick="alert(1)"/><foreignObject fill="white"/></svg>'))).toEqual(['/0', '/1']);
    expect(paths(validateSvg('<svg><circle r="2" fill="banana"/></svg>'))).toEqual(['/0']);
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

  // The reply that was refused with 26 issues such as fill="#f4f4f5": zinc greys, white and a green.
  const refused: [string, string, string][] = [
    ['fill', '#ffffff', 'var(--card)'], ['stroke', '#e4e4e7', 'var(--border)'], ['fill', '#fafafa', 'var(--background)'], ['stroke', '#d4d4d8', 'var(--border)'],
    ['fill', '#f4f4f5', 'var(--muted)'], ['stroke', '#e4e4e7', 'var(--border)'], ['fill', '#18181b', 'var(--foreground)'], ['fill', '#71717a', 'var(--muted-foreground)'],
    ['fill', '#52525b', 'var(--muted-foreground)'], ['fill', '#a1a1aa', 'var(--muted-foreground)'], ['fill', '#27272a', 'var(--foreground)'], ['fill', '#3f3f46', 'var(--foreground)'],
    ['fill', '#09090b', 'var(--foreground)'], ['stroke', '#a1a1aa', 'var(--muted-foreground)'], ['fill', '#22c55e', 'var(--success)'], ['stroke', '#16a34a', 'var(--success)'],
    ['fill', '#ffffff', 'var(--card)'], ['stroke', '#e4e4e7', 'var(--border)'], ['fill', '#f4f4f5', 'var(--muted)'], ['fill', '#fff', 'var(--card)'],
    ['stroke', '#d4d4d8', 'var(--border)'], ['fill', '#18181b', 'var(--foreground)'], ['fill', '#71717a', 'var(--muted-foreground)'], ['fill', '#22c55e', 'var(--success)'],
    ['stop-color', '#22c55e', 'var(--success)'], ['stop-color', '#ffffff', 'var(--card)'],
  ];
  const refusedSvg = `<svg viewBox="0 0 10 10">${refused.map(([name, colour]) => `<rect ${name}="${colour}"/>`).join('')}</svg>`;

  it('maps the 26 literal colours of a refused reply to theme variables, so it validates clean', () => {
    expect(refused).toHaveLength(26);
    expect(validateMarkdownBlocks(`${fence}svg\n${refusedSvg}\n${fence}`)).toEqual([]);
    const { root, source } = parseSvg(refusedSvg);
    const drawn = root?.children.flatMap(child => typeof child === 'string' ? [] : child.attributes);
    expect(drawn).toEqual(refused.map(([name, , paint]) => [name, paint]));
    expect(source).toBe(`<svg viewBox="0 0 10 10">${refused.map(([name, , paint]) => `<rect ${name}="${paint}"/>`).join('')}</svg>`);
  });

  it('maps rgb(), hsl(), named and hex colours by hue and lightness, and keeps an alpha as the paint\'s opacity', () => {
    const mapped: [string, { paint: string; opacity: number } | null][] = [
      ['rgb(239, 68, 68)', { paint: 'var(--destructive)', opacity: 1 }], ['rgba(59, 130, 246, 0.25)', { paint: 'var(--focus-ring)', opacity: 0.25 }],
      ['rgb(245 158 11 / 50%)', { paint: 'var(--warning)', opacity: 0.5 }], ['hsl(142 71% 45%)', { paint: 'var(--success)', opacity: 1 }],
      ['hsla(270, 80%, 60%, 0.5)', { paint: 'var(--chart-2)', opacity: 0.5 }], ['orange', { paint: 'var(--warning)', opacity: 1 }],
      ['Teal', { paint: 'var(--chart-1)', opacity: 1 }], ['hotpink', { paint: 'var(--chart-3)', opacity: 1 }], ['white', { paint: 'var(--card)', opacity: 1 }],
      ['black', { paint: 'var(--foreground)', opacity: 1 }], ['slategray', { paint: 'var(--muted-foreground)', opacity: 1 }], ['#0f172a', { paint: 'var(--foreground)', opacity: 1 }],
      ['#80808080', { paint: 'var(--muted-foreground)', opacity: 0.5 }], ['#dcfce7', { paint: 'var(--success)', opacity: 0.14 }], ['transparent', { paint: 'none', opacity: 1 }],
      ['currentColor', null], ['var(--foreground)', null], ['banana', null], ['rgb(1, 2)', null],
    ];
    expect(mapped.map(([colour]) => [colour, themeColour(colour)])).toEqual(mapped);
    const { root, issues, source } = parseSvg('<svg><rect fill="rgba(255,0,0,.5)" stroke="#00f8" stroke-opacity="0.5"/><text style="fill: hsl(142 71% 45% / 0.4); stroke: red !important">x</text></svg>');
    expect(issues).toEqual([]);
    expect(root?.children).toEqual([
      { name: 'rect', attributes: [['fill', 'var(--destructive)'], ['stroke', 'var(--focus-ring)'], ['stroke-opacity', '0.265'], ['fill-opacity', '0.5']], children: [] },
      { name: 'text', attributes: [['style', 'fill:var(--success); stroke:var(--destructive) !important;fill-opacity:0.4']], children: ['x'] },
    ]);
    expect(source).toBe('<svg><rect fill="var(--destructive)" stroke="var(--focus-ring)" stroke-opacity="0.265" fill-opacity="0.5"/><text style="fill:var(--success); stroke:var(--destructive) !important;fill-opacity:0.4">x</text></svg>');
  });

  it('stores blocks with theme colours: svg fences and Svg elements; other text and mermaid unchanged', () => {
    const spec = { root: 's', elements: { s: { type: 'Svg', props: { svg: '<svg><rect fill="#ef4444"/></svg>' }, children: [] } } };
    const markdown = `Intro <rect fill="#fff"/>\n  ${fence}svg\n  <svg viewBox="0 0 4 4">\n    <rect fill="white"/>\n  </svg>\n  ${fence}\n${fence}gitspace-ui\n${JSON.stringify(spec, null, 2)}\n${fence}\n${fence}mermaid\ngraph TD; A[#fff]-->B\n${fence}\n`;
    const stored = { ...spec, elements: { s: { ...spec.elements.s, props: { svg: '<svg><rect fill="var(--destructive)"/></svg>' } } } };
    expect(mapBlockColours(markdown)).toBe(`Intro <rect fill="#fff"/>\n  ${fence}svg\n  <svg viewBox="0 0 4 4">\n    <rect fill="var(--card)"/>\n  </svg>\n  ${fence}\n${fence}gitspace-ui\n${JSON.stringify(stored)}\n${fence}\n${fence}mermaid\ngraph TD; A[#fff]-->B\n${fence}\n`);
    expect(mapBlockColours('No blocks, #fff')).toBe('No blocks, #fff');
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

describe('Block ids, refs, Sequences and asks', () => {
  const markdownFence = (spec: unknown): string => `${fence}gitspace-ui\n${JSON.stringify(spec)}\n${fence}`;
  const text = (key: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'Text', props: { text: key }, children: [], ...extra });
  const stack = (children: string[], elements: Record<string, unknown>): Record<string, unknown> => ({ root: 'page', elements: { page: { type: 'Stack', props: {}, children }, ...elements }, state: {} });
  const sequence = (frames: unknown[]): Record<string, unknown> => ({ type: 'Sequence', props: { title: 'Walk', frames }, children: [] });

  it('reports an id used twice within a block and across the blocks of one Markdown document', () => {
    expect(paths(validateUiSpec(stack(['a', 'b'], { a: text('a', { id: 'same' }), b: text('b', { id: 'same' }) })))).toEqual(['/elements/b/id']);
    const first = markdownFence(stack(['a'], { a: text('a', { id: 'shared' }) }));
    const second = markdownFence(stack(['b'], { b: text('b', { id: 'shared' }) }));
    expect(validateMarkdownBlocks(`${first}\n\n${second}`)).toEqual([{ path: 'block 2/elements/b/id', message: 'id "shared" is also used by block 1; an id is used once in a document' }]);
    expect(validateMarkdownBlocks(`${first}\n\n${markdownFence(stack(['b'], { b: text('b', { id: 'other' }) }))}`)).toEqual([]);
  });

  it('refuses a Sequence frame holding a Sequence, an ask or an id, and frames that are not 2 to 30', () => {
    const inner = sequence([{ content: { type: 'Text', props: { text: 'x' }, children: [] } }, { content: { type: 'Text', props: { text: 'y' }, children: [] } }]);
    expect(paths(validateUiSpec({ root: 'walk', elements: { walk: sequence([{ content: inner }, { content: { type: 'Text', props: { text: 'ok' }, children: [] }, say: 'Fine.' }]) } }))).toContain('/elements/walk/props/frames/0/content/type');
    expect(paths(validateUiSpec({ root: 'walk', elements: { walk: sequence([{ content: { type: 'Card', props: {}, children: ['nested'] } }, { content: { ref: 'x' } }]), nested: inner } })))
      .toContain('/elements/walk/props/frames/0/content/children/0');
    const asking = validateUiSpec({ root: 'walk', elements: { walk: sequence([{ content: { type: 'Text', props: { text: 'a' }, children: [], ask: { required: false } } }, { content: { type: 'Text', props: { text: 'b' }, children: [], id: 'b' } }]) } });
    expect(paths(asking)).toEqual(['/elements/walk/props/frames/0/content/ask', '/elements/walk/props/frames/1/content/id']);
    expect(paths(validateUiSpec({ root: 'walk', elements: { walk: sequence([{ content: { type: 'Text', props: { text: 'only' }, children: [] } }]) } }))).toEqual(['/elements/walk/props/frames']);
  });

  it('reports a ref to an id the document does not have, and accepts refs to other documents', () => {
    const walk = sequence([{ content: { ref: 'stats' } }, { content: { ref: 'missing' } }]);
    const markdown = `${markdownFence(stack(['s'], { s: { type: 'Stats', id: 'stats', props: { tiles: [] }, children: [] } }))}\n${markdownFence({ root: 'walk', elements: { walk, again: { type: 'BlockRef', props: { id: 'gone' }, children: [] }, away: { type: 'BlockRef', props: { id: 'guide:3#overview' }, children: [] } } })}`;
    expect(paths(validateMarkdownBlocks(markdown))).toEqual(['block 2/elements/walk/props/frames/1/content/ref', 'block 2/elements/again/props/id']);
  });

  it('requires an id on an element with a required ask, and reads the choices its block offers', () => {
    expect(paths(validateUiSpec({ root: 'card', elements: { card: { type: 'Card', props: {}, children: [], ask: { required: true } } } }))).toEqual(['/elements/card/ask']);
    const choice = UI_BLOCK_EXAMPLES.find((example) => example.title === 'A choice for the person');
    expect(requiredBlockAsks(`Pick one:\n${fence}gitspace-ui\n${choice?.body ?? ''}\n${fence}`)).toEqual([{ id: 'cache-choice', prompt: 'Which cache keeps the replies?', choices: ['Workers KV', 'Durable Object'] }]);
    const card = { type: 'AskCard', id: 'q', ask: { required: true }, props: { questionId: 'q', question: 'Ship it?', prompt: 'Ship?', options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }], value: '' }, children: [] };
    expect(requiredBlockAsks(markdownFence({ root: 'q', elements: { q: card } }))).toEqual([{ id: 'q', prompt: 'Ship it?', choices: ['Yes', 'No'] }]);
    expect(requiredBlockAsks(markdownFence({ root: 'q', elements: { q: { ...card, ask: { required: false } } } }))).toEqual([]);
  });
});

describe('Short-form blocks', () => {
  const lines = [{ depth: 0, code: 'reply(req)', change: 'same' }, { depth: 1, code: 'cache.get(key)', change: 'added', note: 'strong reads' }];

  it('expands a fence naming one component to the full spec of that one element, and validates it', () => {
    const markdown = `Fix:\n${fence}gitspace-ui CallDiff id=fix-path\n${JSON.stringify({ title: 'Reads', lines })}\n${fence}`;
    const full = { root: 'block', elements: { block: { type: 'CallDiff', props: { title: 'Reads', lines }, children: [], id: 'fix-path' } }, state: {} };
    const [block] = extractBlocks(markdown);
    expect(block?.info).toBe('CallDiff id=fix-path');
    expect(fenceSpec(block?.body ?? '', block?.info ?? '')).toEqual({ spec: full });
    expect(validateMarkdownBlocks(markdown)).toEqual([]);
    expect(validateMarkdownBlocks(`${fence}gitspace-ui\n${JSON.stringify(full)}\n${fence}`)).toEqual([]);
    expect(paths(validateMarkdownBlocks(`${fence}gitspace-ui CallDiff\n${JSON.stringify({ lines: [{ ...lines[0], change: 'moved' }] })}\n${fence}`))).toEqual(['block 1/elements/block/props/lines/0/change']);
  });

  it('makes a required block ask from id and ask=required, and none from a plain ask', () => {
    const card = JSON.stringify({ question: 'Which cache keeps replies?', options: [{ value: 'kv', label: 'Workers KV' }, { value: 'do', label: 'Durable Object' }] });
    const required = `Pick one:\n${fence}gitspace-ui AskCard id=cache ask=required\n${card}\n${fence}`;
    expect(validateMarkdownBlocks(required)).toEqual([]);
    expect(requiredBlockAsks(required)).toEqual([{ id: 'cache', prompt: 'Which cache keeps replies?', choices: ['Workers KV', 'Durable Object'] }]);
    expect(requiredBlockAsks(`${fence}gitspace-ui AskCard id=cache ask\n${card}\n${fence}`)).toEqual([]);
    expect(paths(validateMarkdownBlocks(`${fence}gitspace-ui AskCard ask=required\n${card}\n${fence}`))).toEqual(['block 1/elements/block/ask']);
  });

  it('refuses an unknown component with the closest names, and an unknown option', () => {
    expect(validateMarkdownBlocks(`${fence}gitspace-ui CalDiff\n{}\n${fence}`)).toEqual([{ path: 'block 1', message: 'unknown component "CalDiff" in the fence\'s info string; the closest are CallDiff, Diff, Card' }]);
    expect(validateMarkdownBlocks(`${fence}gitspace-ui Stats required\n{"tiles":[]}\n${fence}`)).toEqual([{ path: 'block 1', message: 'unknown option "required" in the fence\'s info string; after the component it takes id=<id>, ask or ask=required' }]);
  });

  it('keeps a short-form Svg in its short form when its colours are mapped', () => {
    const markdown = `${fence}gitspace-ui Svg id=map\n${JSON.stringify({ svg: '<svg viewBox="0 0 4 4"><rect fill="#fff"/></svg>' })}\n${fence}`;
    expect(mapBlockColours(markdown)).toBe(`${fence}gitspace-ui Svg id=map\n${JSON.stringify({ svg: '<svg viewBox="0 0 4 4"><rect fill="var(--card)"/></svg>' })}\n${fence}`);
  });
});

describe('The drawing brief', () => {
  it('shows a short-form body for each of its components, every one valid', () => {
    const shapes = [...UI_BLOCK_BRIEF.matchAll(/^- (\w+)((?: [\w=.-]+)*) (\{.*?\})(?:; also: .*)?$/gmu)];
    expect(shapes.map((shape) => shape[1])).toEqual(['CallDiff', 'StateFlow', 'Table', 'Stats', 'MetricDelta', 'Chart', 'Tradeoffs', 'AskCard', 'Timeline', 'Sequence', 'Reply', 'Svg']);
    const markdown = shapes.map((shape) => `${fence}gitspace-ui ${shape[1]}${shape[2]}\n${shape[3]}\n${fence}`).join('\n\n');
    expect(validateMarkdownBlocks(markdown)).toEqual([]);
    expect(requiredBlockAsks(markdown).map((ask) => ask.id)).toEqual(['cache']);
  });

  it('stays within its budget of 4,500 characters', () => {
    expect(UI_BLOCK_BRIEF.length).toBeLessThanOrEqual(4500);
  });

  it('points at the builders, and the skill documents each one', () => {
    expect(UI_BLOCK_BRIEF).toContain('Show real data with builders: `tools.blocks({ op })`, op diff, excerpt, changeSet, commandRun or testReport, returns a ready fence; paste it, add notes.');
    const skill = uiBlockPrompt();
    for (const builder of ['diff { path, base? } → Diff', 'excerpt { path, start, end, commit?, highlight?, note? } → CodeExcerpt', 'changeSet { base? } → ChangeSet', 'commandRun { jobId } or { process, on? } → CommandRun', 'testReport { jobId } or { process, on? } → TestReport']) expect(skill).toContain(`- ${builder}`);
  });
});
