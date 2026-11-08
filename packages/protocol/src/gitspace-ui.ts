// GitSpace UI blocks: the fenced blocks an agent may write in Markdown (```gitspace-ui, ```svg, ```mermaid), the catalog
// a gitspace-ui spec may use, the validator GitSpace runs before it stores a block, and the agent's instructions.
// A gitspace-ui spec has json-render's shape { root, elements, state }; the catalog is plain zod so the protocol needs no
// json-render dependency.
import { z } from 'zod';

export interface UiBlockIssue {
  path: string;
  message: string;
}

export type UiBlockKind = 'gitspace-ui' | 'svg' | 'mermaid';

export interface UiBlock {
  kind: UiBlockKind;
  body: string;
  /** Offset of the opening fence line. */
  start: number;
  /** Offset just past the closing fence line, or the end of the Markdown when the fence is not closed. */
  end: number;
  closed: boolean;
}

/** One element of a parsed SVG drawing; attribute values and text are entity-decoded. */
export interface SvgElementNode {
  name: string;
  attributes: [name: string, value: string][];
  children: (SvgElementNode | string)[];
}

export interface ParsedSvg {
  /** The first root element; null when there is none. Draw it only when `issues` is empty. */
  root: SvgElementNode | null;
  issues: UiBlockIssue[];
}

export interface UiComponent {
  props: z.ZodObject<z.core.$ZodShape, z.core.$strict>;
  slots?: readonly string[];
  description: string;
}

export interface UiAction {
  params: z.ZodObject<z.core.$ZodShape, z.core.$strict>;
  description: string;
}

export interface UiFunction {
  description: string;
}

const BLOCK_KINDS: readonly UiBlockKind[] = ['gitspace-ui', 'svg', 'mermaid'];
const MAX_ELEMENTS = 256;
const MAX_SPEC_BYTES = 128 * 1024;
const MAX_SVG_BYTES = 64 * 1024;
const MAX_MERMAID_BYTES = 16 * 1024;
/** State roots GitSpace writes: a spec may read them without seeding them. */
const GITSPACE_STATE_ROOTS = new Set(['answered', 'staged', 'sent', 'gitspaceNotices']);
/** The SVG elements a drawing may use. */
export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'defs',
  'marker', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'use', 'symbol',
]);
const SVG_PAINT_PROPERTIES = new Set(['fill', 'stroke', 'color', 'stop-color', 'flood-color', 'lighting-color']);
const SVG_THEME_VARIABLES = ['--foreground', '--muted-foreground', '--background', '--border', '--accent', '--destructive', '--focus-ring', '--surface-2'];

const color = z.enum(['gray', 'blue', 'green', 'red', 'amber', 'orange', 'violet', 'indigo', 'cyan', 'emerald', 'pink']);
const gap = z.enum(['sm', 'md', 'lg']);
const cell = z.union([z.string(), z.number()]);
const pane = z.strictObject({ label: z.string(), title: z.string().nullish(), body: z.string().describe('Markdown') });
const option = z.strictObject({ value: z.string(), label: z.string(), description: z.string().nullish() });

const components = {
  Card: {
    props: z.strictObject({ title: z.string().nullish(), description: z.string().nullish(), eyebrow: z.string().nullish() }),
    slots: ['default', 'footer'],
    description: 'A titled block. Put its actions in the "footer" slot.',
  },
  Stack: {
    props: z.strictObject({ gap: gap.nullish() }),
    slots: ['default'],
    description: 'Children top to bottom.',
  },
  Row: {
    props: z.strictObject({ gap: gap.nullish(), justify: z.enum(['start', 'between', 'end']).nullish(), wrap: z.boolean().nullish() }),
    slots: ['default'],
    description: 'Children side by side, vertically centred.',
  },
  Text: {
    props: z.strictObject({ text: z.string(), size: z.enum(['title', 'body', 'caption']).nullish(), tone: z.enum(['default', 'muted', 'good', 'bad']).nullish(), mono: z.boolean().nullish() }),
    description: 'One paragraph of plain text.',
  },
  Markdown: {
    props: z.strictObject({ content: z.string() }),
    description: 'GitHub-flavoured Markdown: emphasis, code, lists, links, tables.',
  },
  Badge: {
    props: z.strictObject({ label: z.string(), color: color.nullish(), variant: z.enum(['solid', 'dot']).nullish() }),
    description: 'A short status label.',
  },
  Table: {
    props: z.strictObject({
      columns: z.array(z.strictObject({ key: z.string(), label: z.string(), align: z.enum(['left', 'right']).nullish().describe('"left" or "right" only; there is no "center"'), mono: z.boolean().nullish() })),
      rows: z.array(z.record(z.string(), cell)),
      caption: z.string().nullish(),
    }),
    description: 'Rows of cells keyed by column key. Cells are text or numbers; text may use `code` spans.',
  },
  Stats: {
    props: z.strictObject({
      tiles: z.array(z.strictObject({ label: z.string(), value: cell, detail: z.string().nullish(), tone: z.enum(['neutral', 'good', 'bad']).nullish() })),
    }),
    description: 'A row of headline numbers. Each tile is an object { label, value, detail?, tone? }: label names the number, value is the headline ("3.7 s" or 42), detail is one short line under it, tone is "neutral", "good" or "bad".',
  },
  Chart: {
    props: z.strictObject({
      title: z.string().nullish(),
      unit: z.enum(['ms', 'seconds', 'count', 'percent']),
      series: z.array(z.strictObject({ key: z.string(), label: z.string(), color })),
      rows: z.array(z.strictObject({ label: z.string(), values: z.record(z.string(), z.number()).describe('series key → value') })),
      max: z.number().nullish(),
    }),
    description: `Horizontal bars, one group per row and one bar per series. Values are in \`unit\`; ms values are shown in seconds. A series color is a name, one of ${color.options.join(', ')}; never a hex value.`,
  },
  Checklist: {
    props: z.strictObject({ title: z.string().nullish() }),
    slots: ['default'],
    description: 'A list of ChecklistItem children, usually from `repeat` over a state array.',
  },
  ChecklistItem: {
    props: z.strictObject({ index: z.number(), label: z.string(), checked: z.boolean(), note: z.string().nullish() }),
    description: 'One tickable row inside a Checklist. Bind `checked` with $bindItem, set `index` with {"$index": true}. Emits "change" after it is ticked or unticked.',
  },
  Steps: {
    props: z.strictObject({
      steps: z.array(z.strictObject({ title: z.string(), detail: z.string(), where: z.string().nullish() })),
      active: z.number(),
      play: z.boolean().nullish(),
      intervalMs: z.number().nullish(),
    }),
    description: 'A numbered path with one highlighted step. Bind `active` with $bindState. With `play`, a play/pause control steps through the highlights.',
  },
  Switch: {
    props: z.strictObject({ label: z.string(), checked: z.boolean() }),
    description: 'An on/off toggle. Bind `checked` with $bindState. Emits "change".',
  },
  Segmented: {
    props: z.strictObject({ options: z.array(z.strictObject({ value: z.string(), label: z.string() })), value: z.string() }),
    description: 'Pick one of a few views. Bind `value` with $bindState. Emits "change".',
  },
  RadioGroup: {
    props: z.strictObject({ label: z.string().nullish(), options: z.array(option), value: z.string() }),
    description: 'Pick one answer. Bind `value` with $bindState; the selected option\'s description shows under the group. Emits "change".',
  },
  TextField: {
    props: z.strictObject({ label: z.string(), value: z.string(), placeholder: z.string().nullish() }),
    description: 'One line of free text. Bind `value` with $bindState.',
  },
  Button: {
    props: z.strictObject({ label: z.string(), variant: z.enum(['primary', 'secondary', 'tertiary', 'ghost']).nullish(), disabled: z.boolean().nullish() }),
    description: 'Emits "press".',
  },
  Diff: {
    props: z.strictObject({ patch: z.string().describe('A unified diff of one file, with its diff --git header'), title: z.string().nullish() }),
    description: 'A small code change drawn as GitSpace draws diffs.',
  },
  RunTag: {
    props: z.strictObject({ commit: z.string(), machine: z.string(), sample: z.string(), label: z.string().nullish() }),
    description: 'Names the run a number came from: commit · machine · sample.',
  },
  BeforeAfter: {
    props: z.strictObject({ before: pane, after: pane, slider: z.boolean().nullish() }),
    description: 'Two panes compared. Each pane is an object { label, title?, body } whose body is a Markdown string, not element keys. With `slider`, the panes overlap and a slider wipes between them.',
  },
  AskCard: {
    props: z.strictObject({
      questionId: z.string(),
      question: z.string().describe('The question in one line, for the answered summary'),
      prompt: z.string().describe('Markdown: the context and the question'),
      options: z.array(option),
      value: z.string(),
      staged: z.string().nullish(),
      sent: z.string().nullish(),
      answered: z.string().nullish(),
    }),
    description: 'Your question card. Bind `value` with $bindState; read `staged` and `sent` with $state from /staged/<questionId> and /sent/<questionId>, and `answered` from /answered. Emits "answer" once an option is picked.',
  },
  Svg: {
    props: z.strictObject({ svg: z.string().describe('One literal <svg> element, never an expression; the SVG rules apply') }),
    description: 'A themed drawing.',
  },
  Mermaid: {
    props: z.strictObject({ source: z.string().describe('Mermaid source, at most 16 KiB') }),
    description: 'A Mermaid diagram: flowchart, sequence, state, class or gantt.',
  },
} satisfies Record<string, UiComponent>;

const actions = {
  record_decision: {
    params: z.strictObject({ question: z.string(), choice: z.string(), rationale: z.string().nullish() }),
    description: 'Record the person\'s decision in the workspace journal.',
  },
  send_to_agent: {
    params: z.strictObject({ message: z.string(), data: z.unknown().nullish() }),
    description: 'Send you a message, with optional structured data from state.',
  },
  open_guide_section: {
    params: z.strictObject({ section: z.string(), title: z.string().nullish() }),
    description: 'Open the Change Guide at a section id.',
  },
  accept_requirement: {
    params: z.strictObject({ id: z.string(), accepted: z.boolean(), label: z.string().nullish(), checkedPath: z.string().nullish().describe('Inside repeat, {"$item": "<field>"} gives the path of the row\'s checked flag') }),
    description: 'Accept (or reopen) a goal requirement by id. A sign-off: GitSpace records it at once.',
  },
  answer_question: {
    params: z.strictObject({ questionId: z.string(), question: z.string(), answer: z.string(), label: z.string() }),
    description: 'Answer your pending question; you continue. GitSpace sets /answered to the label.',
  },
  stage: {
    params: z.strictObject({
      kind: z.enum(['decision', 'answer', 'review', 'requirement']),
      key: z.string().nullish().describe('One chip per key per block; staging the same key again replaces the chip. Defaults to kind.'),
      label: z.string(),
      detail: z.string().nullish(),
      payload: z.unknown().nullish(),
    }),
    description: 'Put a choice in the person\'s message bar as a chip instead of acting on it. It goes to you with their next message. GitSpace sets /staged/<key> to the label while it waits, and /sent/<key> once it is sent.',
  },
  open_url: {
    params: z.strictObject({ url: z.string(), label: z.string().nullish() }),
    description: 'Open a link (a GitHub thread, a run log) in a new tab.',
  },
} satisfies Record<string, UiAction>;

/** json-render's built-in actions; the renderer implements them. */
const builtInActions: Readonly<Record<string, UiAction>> = {
  setState: {
    params: z.strictObject({ statePath: z.string(), value: z.unknown() }),
    description: 'Set the value at statePath.',
  },
  pushState: {
    params: z.strictObject({ statePath: z.string(), value: z.unknown(), clearStatePath: z.string().nullish() }),
    description: 'Append value to the array at statePath; "$id" inside value becomes a fresh id; clearStatePath is reset to "".',
  },
  removeState: {
    params: z.strictObject({ statePath: z.string(), index: z.number() }),
    description: 'Remove the item at index from the array at statePath.',
  },
  validateForm: {
    params: z.strictObject({ statePath: z.string().nullish() }),
    description: 'Check the block\'s inputs and write { valid, errors } to statePath (default /formValidation).',
  },
};

const functions: Readonly<Record<string, UiFunction>> = {
  progress: { description: 'args { items: array, field: string, noun: string } → "N of M <noun>", counting items whose field is true.' },
  pick: { description: 'args { items: array, index: number, field: string } → items[index][field]: one field of the item a state index points at.' },
  where: { description: 'args { items: array, field: string } → the items whose field is true, e.g. to send only the ticked rows.' },
  lookup: { description: 'args { items: array, key: string, value: any, field: string } → field of the first item whose key equals value, e.g. an option\'s label from its value.' },
};

/** The whole vocabulary of a gitspace-ui spec: components, the actions GitSpace implements, and `$computed` functions. */
export const gitspaceUiCatalog = { components, actions, functions };

const componentByType = new Map<string, UiComponent>(Object.entries(components));
const actionByName = new Map<string, UiAction>([...Object.entries(builtInActions), ...Object.entries(actions)]);
const functionNames = new Set(Object.keys(functions));
const confirmSchema = z.strictObject({ title: z.string(), message: z.string(), confirmLabel: z.string().nullish(), cancelLabel: z.string().nullish(), variant: z.enum(['default', 'danger']).nullish() });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Finds the ```gitspace-ui, ```svg and ```mermaid fences in Markdown; other fences (and anything inside them) are skipped. */
export function extractBlocks(markdown: string): UiBlock[] {
  const blocks: UiBlock[] = [];
  let open: { fence: string; indent: number; kind: UiBlockKind | undefined; start: number; lines: string[] } | undefined;
  let offset = 0;
  for (const rawLine of markdown.split('\n')) {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (open === undefined) {
      const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (opening === null) continue;
      const info = opening[3].trim();
      if (opening[2].startsWith('`') && info.includes('`')) continue;
      open = { fence: opening[2], indent: opening[1].length, kind: BLOCK_KINDS.find((kind) => kind === info), start: lineStart, lines: [] };
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (closing !== null && closing[1][0] === open.fence[0] && closing[1].length >= open.fence.length) {
      if (open.kind !== undefined) blocks.push({ kind: open.kind, body: open.lines.join('\n'), start: open.start, end: lineStart + rawLine.length, closed: true });
      open = undefined;
      continue;
    }
    if (open.kind !== undefined) open.lines.push(line.replace(new RegExp(`^ {0,${open.indent}}`), ''));
  }
  if (open?.kind !== undefined) blocks.push({ kind: open.kind, body: open.lines.join('\n'), start: open.start, end: markdown.length, closed: false });
  return blocks;
}

/** Validates every block in Markdown. Issue paths start with `block <n>` (1-based, counting only these fences). */
export function validateMarkdownBlocks(markdown: string): UiBlockIssue[] {
  const issues: UiBlockIssue[] = [];
  extractBlocks(markdown).forEach((block, index) => {
    for (const found of validateBlock(block)) issues.push({ path: `block ${index + 1}${found.path}`, message: found.message });
  });
  return issues;
}

function validateBlock(block: UiBlock): UiBlockIssue[] {
  if (!block.closed) return [{ path: '', message: `the \`\`\`${block.kind} fence is not closed` }];
  if (block.kind === 'svg') return validateSvg(block.body);
  if (block.kind === 'mermaid') return validateMermaid(block.body);
  let spec: unknown;
  try {
    spec = JSON.parse(block.body);
  } catch (error) {
    return [{ path: '', message: `the gitspace-ui block is not JSON: ${error instanceof Error ? error.message : String(error)}` }];
  }
  return validateUiSpec(spec);
}

function validateMermaid(source: string): UiBlockIssue[] {
  if (source.trim() === '') return [{ path: '', message: 'the Mermaid source is empty' }];
  const bytes = byteLength(source);
  return bytes > MAX_MERMAID_BYTES ? [{ path: '', message: `the Mermaid source is ${bytes} bytes; the limit is ${MAX_MERMAID_BYTES}` }] : [];
}

interface SpecCheck {
  state: unknown;
  issues: UiBlockIssue[];
}

/** Validates a gitspace-ui spec. Issue paths are JSON pointers into the spec. */
export function validateUiSpec(spec: unknown): UiBlockIssue[] {
  if (!isRecord(spec)) return [{ path: '', message: 'a gitspace-ui spec is one JSON object { "root", "elements", "state" }' }];
  let bytes: number;
  try {
    bytes = byteLength(JSON.stringify(spec));
  } catch {
    return [{ path: '', message: 'the spec is not JSON' }];
  }
  if (bytes > MAX_SPEC_BYTES) return [{ path: '', message: `the spec is ${bytes} bytes; the limit is ${MAX_SPEC_BYTES}` }];
  const check: SpecCheck = { state: spec.state ?? {}, issues: [] };
  for (const key of Object.keys(spec)) {
    if (key !== 'root' && key !== 'elements' && key !== 'state') check.issues.push({ path: pointer('', key), message: `unknown field "${key}"; a spec has root, elements and state` });
  }
  if (spec.state !== undefined && !isRecord(spec.state)) check.issues.push({ path: '/state', message: 'state is an object' });
  const { root, elements } = spec;
  if (typeof root !== 'string') check.issues.push({ path: '/root', message: 'root is the key of the root element' });
  if (!isRecord(elements)) {
    check.issues.push({ path: '/elements', message: 'elements is an object mapping each element key to its element' });
    return check.issues;
  }
  const keys = Object.keys(elements);
  if (keys.length > MAX_ELEMENTS) {
    check.issues.push({ path: '/elements', message: `the spec has ${keys.length} elements; the limit is ${MAX_ELEMENTS}` });
    return check.issues;
  }
  if (typeof root === 'string' && !Object.hasOwn(elements, root)) check.issues.push({ path: '/root', message: `no element "${root}" in elements` });
  for (const key of keys) validateElement(elements, key, check);
  if (typeof root === 'string' && Object.hasOwn(elements, root)) findCycles(elements, root, check.issues);
  return check.issues;
}

const ELEMENT_FIELDS = new Set(['type', 'props', 'children', 'slots', 'visible', 'repeat', 'on', 'watch']);

function validateElement(elements: Record<string, unknown>, key: string, check: SpecCheck): void {
  const path = pointer('/elements', key);
  const element = elements[key];
  if (!isRecord(element)) {
    check.issues.push({ path, message: 'an element is an object { type, props, children }' });
    return;
  }
  for (const field of Object.keys(element)) {
    if (!ELEMENT_FIELDS.has(field)) check.issues.push({ path: pointer(path, field), message: `unknown element field "${field}"; an element has ${[...ELEMENT_FIELDS].join(', ')}` });
  }
  const type = element.type;
  const component = typeof type === 'string' ? componentByType.get(type) : undefined;
  if (component === undefined) {
    check.issues.push({ path: pointer(path, 'type'), message: typeof type === 'string' ? `unknown component "${type}"; use one of ${[...componentByType.keys()].join(', ')}` : 'type names a component' });
  }
  const propsPath = pointer(path, 'props');
  if (!isRecord(element.props)) check.issues.push({ path: propsPath, message: 'props is an object' });
  else if (component !== undefined) {
    checkObject(component.props.shape, element.props, propsPath, check, `prop of ${String(type)}`);
    if (type === 'Svg' && typeof element.props.svg === 'string') {
      for (const found of validateSvg(element.props.svg)) check.issues.push({ path: `${pointer(propsPath, 'svg')}${found.path}`, message: found.message });
    } else if (type === 'Svg' && element.props.svg !== undefined) {
      check.issues.push({ path: pointer(propsPath, 'svg'), message: 'svg is one literal <svg> string, never an expression' });
    } else if (type === 'Mermaid' && typeof element.props.source === 'string') {
      for (const found of validateMermaid(element.props.source)) check.issues.push({ path: pointer(propsPath, 'source'), message: found.message });
    }
  }
  checkElementChildren(elements, element, path, component, check.issues);
  if (element.visible !== undefined) checkCondition(element.visible, pointer(path, 'visible'), check);
  if (element.repeat !== undefined) checkRepeat(element.repeat, pointer(path, 'repeat'), check);
  if (element.on !== undefined) checkBindings(element.on, pointer(path, 'on'), check);
  if (element.watch !== undefined) checkBindings(element.watch, pointer(path, 'watch'), check);
}

function checkElementChildren(elements: Record<string, unknown>, element: Record<string, unknown>, path: string, component: UiComponent | undefined, issues: UiBlockIssue[]): void {
  const childrenPath = pointer(path, 'children');
  if (!Array.isArray(element.children)) issues.push({ path: childrenPath, message: 'children is an array of element keys ([] for an element without children)' });
  else {
    checkKeys(elements, element.children, childrenPath, issues);
    if (component !== undefined && component.slots === undefined && element.children.length > 0) issues.push({ path: childrenPath, message: `${String(element.type)} takes no children` });
  }
  if (element.slots === undefined) return;
  const slotsPath = pointer(path, 'slots');
  if (!isRecord(element.slots)) {
    issues.push({ path: slotsPath, message: 'slots is an object mapping a slot name to element keys' });
    return;
  }
  for (const [slot, keys] of Object.entries(element.slots)) {
    const slotPath = pointer(slotsPath, slot);
    if (component !== undefined && (slot === 'default' || !component.slots?.includes(slot))) {
      const named = component.slots?.filter((name) => name !== 'default') ?? [];
      issues.push({ path: slotPath, message: slot === 'default' ? 'put default-slot children in "children", not slots.default' : `${String(element.type)} has no slot "${slot}"${named.length > 0 ? `; its slots are ${named.join(', ')}` : ''}` });
    }
    if (Array.isArray(keys)) checkKeys(elements, keys, slotPath, issues);
    else issues.push({ path: slotPath, message: 'a slot is an array of element keys' });
  }
}

function checkKeys(elements: Record<string, unknown>, keys: unknown[], path: string, issues: UiBlockIssue[]): void {
  keys.forEach((key, index) => {
    if (typeof key !== 'string') issues.push({ path: pointer(path, index), message: 'a child is an element key' });
    else if (!Object.hasOwn(elements, key)) issues.push({ path: pointer(path, index), message: `no element "${key}" in elements` });
  });
}

function childReferences(element: unknown): { key: string; path: string }[] {
  if (!isRecord(element)) return [];
  const references: { key: string; path: string }[] = [];
  const lists: [string, unknown][] = [['/children', element.children]];
  if (isRecord(element.slots)) for (const [slot, keys] of Object.entries(element.slots)) lists.push([pointer('/slots', slot), keys]);
  for (const [path, keys] of lists) {
    if (!Array.isArray(keys)) continue;
    keys.forEach((key, index) => {
      if (typeof key === 'string') references.push({ key, path: pointer(path, index) });
    });
  }
  return references;
}

function findCycles(elements: Record<string, unknown>, root: string, issues: UiBlockIssue[]): void {
  const done = new Set<string>();
  const ancestors = new Set<string>();
  const visit = (key: string): void => {
    ancestors.add(key);
    for (const reference of childReferences(elements[key])) {
      if (!Object.hasOwn(elements, reference.key)) continue;
      if (ancestors.has(reference.key)) issues.push({ path: `${pointer('/elements', key)}${reference.path}`, message: `element "${reference.key}" contains itself` });
      else if (!done.has(reference.key)) visit(reference.key);
    }
    ancestors.delete(key);
    done.add(key);
  };
  visit(root);
}

function checkRepeat(repeat: unknown, path: string, check: SpecCheck): void {
  if (!isRecord(repeat)) {
    check.issues.push({ path, message: 'repeat is { "statePath": "/array", "key": "id" }' });
    return;
  }
  for (const field of Object.keys(repeat)) {
    if (field !== 'statePath' && field !== 'key') check.issues.push({ path: pointer(path, field), message: `unknown repeat field "${field}"` });
  }
  const statePath = repeat.statePath;
  const statePathPointer = pointer(path, 'statePath');
  if (typeof statePath === 'string') {
    if (checkStateRead(statePath, statePathPointer, check) && !isGitSpaceStatePath(statePath) && !Array.isArray(readState(check.state, statePath))) {
      check.issues.push({ path: statePathPointer, message: `"${statePath}" in state is not an array` });
    }
  } else if (!(isRecord(statePath) && typeof statePath.$item === 'string' && Object.keys(statePath).length === 1)) {
    check.issues.push({ path: statePathPointer, message: 'statePath is a state path, or {"$item": "<field>"} inside another repeat' });
  }
  if (repeat.key !== undefined && typeof repeat.key !== 'string') check.issues.push({ path: pointer(path, 'key'), message: 'key is the name of an item field' });
}

function checkBindings(bindings: unknown, path: string, check: SpecCheck): void {
  if (!isRecord(bindings)) {
    check.issues.push({ path, message: 'a binding map is an object { "<event>": { "action": "<name>", "params": { … } } }' });
    return;
  }
  for (const [event, binding] of Object.entries(bindings)) {
    const eventPath = pointer(path, event);
    if (Array.isArray(binding)) binding.forEach((item, index) => checkBinding(item, pointer(eventPath, index), check));
    else checkBinding(binding, eventPath, check);
  }
}

function checkBinding(binding: unknown, path: string, check: SpecCheck): void {
  if (!isRecord(binding)) {
    check.issues.push({ path, message: 'an action binding is { "action": "<name>", "params": { … } }' });
    return;
  }
  for (const field of Object.keys(binding)) {
    if (field !== 'action' && field !== 'params' && field !== 'confirm' && field !== 'preventDefault') check.issues.push({ path: pointer(path, field), message: `unknown binding field "${field}"; a binding has action, params, confirm and preventDefault` });
  }
  const name = binding.action;
  const action = typeof name === 'string' ? actionByName.get(name) : undefined;
  if (action === undefined) {
    check.issues.push({ path: pointer(path, 'action'), message: typeof name === 'string' ? `unknown action "${name}"; use one of ${[...actionByName.keys()].join(', ')}` : 'action names an action' });
  } else {
    const params = binding.params ?? {};
    if (isRecord(params)) checkObject(action.params.shape, params, pointer(path, 'params'), check, `param of ${String(name)}`);
    else check.issues.push({ path: pointer(path, 'params'), message: 'params is an object' });
  }
  if (binding.confirm !== undefined) checkValue(confirmSchema, binding.confirm, pointer(path, 'confirm'), check);
  if (binding.preventDefault !== undefined && typeof binding.preventDefault !== 'boolean') check.issues.push({ path: pointer(path, 'preventDefault'), message: 'preventDefault is true or false' });
}

/** Checks an object against a zod shape, naming unknown and missing keys with `noun`. */
function checkObject(shape: z.core.$ZodShape, value: Record<string, unknown>, path: string, check: SpecCheck, noun: string): void {
  for (const [key, item] of Object.entries(value)) {
    const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (field === undefined) check.issues.push({ path: pointer(path, key), message: `unknown ${noun} "${key}"; known: ${Object.keys(shape).join(', ') || 'none'}` });
    else checkValue(field, item, pointer(path, key), check);
  }
  for (const [key, field] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key) && !z.safeParse(field, undefined).success) check.issues.push({ path: pointer(path, key), message: `missing ${noun} "${key}"` });
  }
}

const EXPRESSION_KEYS = ['$state', '$item', '$index', '$bindState', '$bindItem', '$cond', '$computed', '$template'];

function expressionKey(value: unknown): string | undefined {
  return isRecord(value) ? EXPRESSION_KEYS.find((key) => Object.hasOwn(value, key)) : undefined;
}

function hasExpression(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExpression);
  if (!isRecord(value)) return false;
  return expressionKey(value) !== undefined || Object.values(value).some(hasExpression);
}

function pushZodIssues(error: z.ZodError, path: string, issues: UiBlockIssue[]): void {
  for (const found of error.issues) issues.push({ path: found.path.reduce<string>((base, key) => pointer(base, String(key)), path), message: found.message });
}

/** Checks a literal value against its schema; expressions may stand in for the value or any part of it. */
function checkValue(schema: z.core.$ZodType, value: unknown, path: string, check: SpecCheck): void {
  if (expressionKey(value) !== undefined && isRecord(value)) {
    checkExpression(schema, value, path, check);
    return;
  }
  if (!hasExpression(value)) {
    const result = z.safeParse(schema, value);
    if (!result.success) pushZodIssues(result.error, path, check.issues);
    return;
  }
  let inner = schema;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) inner = inner.unwrap();
  if (inner instanceof z.ZodObject && isRecord(value)) checkObject(inner.shape, value, path, check, 'field');
  else if (inner instanceof z.ZodArray && Array.isArray(value)) value.forEach((item, index) => checkValue(inner.element, item, pointer(path, index), check));
  else if (inner instanceof z.ZodRecord && isRecord(value)) for (const [key, item] of Object.entries(value)) checkValue(inner.valueType, item, pointer(path, key), check);
  else if (inner instanceof z.ZodUnion) {
    let best: UiBlockIssue[] | undefined;
    for (const candidate of inner.options) {
      const attempt: SpecCheck = { state: check.state, issues: [] };
      checkValue(candidate, value, path, attempt);
      if (best === undefined || attempt.issues.length < best.length) best = attempt.issues;
    }
    check.issues.push(...(best ?? []));
  } else {
    const result = z.safeParse(schema, value);
    if (result.success) checkExpressionsIn(value, path, check);
    else pushZodIssues(result.error, path, check.issues);
  }
}

/** Checks the expressions inside a value no schema describes ($computed args, unknown params). */
function checkExpressionsIn(value: unknown, path: string, check: SpecCheck): void {
  if (Array.isArray(value)) value.forEach((item, index) => checkExpressionsIn(item, pointer(path, index), check));
  else if (isRecord(value) && expressionKey(value) !== undefined) checkExpression(undefined, value, path, check);
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) checkExpressionsIn(item, pointer(path, key), check);
}

function checkExpression(schema: z.core.$ZodType | undefined, value: Record<string, unknown>, path: string, check: SpecCheck): void {
  const key = expressionKey(value);
  const allowed = key === '$cond' ? ['$cond', '$then', '$else'] : key === '$computed' ? ['$computed', 'args'] : [key];
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) check.issues.push({ path: pointer(path, field), message: `unexpected "${field}" in a ${key} expression` });
  }
  const operand = key === undefined ? undefined : value[key];
  const operandPath = pointer(path, key ?? '');
  switch (key) {
    case '$state':
    case '$bindState':
      if (typeof operand !== 'string') check.issues.push({ path: operandPath, message: `${key} takes a state path` });
      else if (key === '$state') checkStateRead(operand, operandPath, check);
      return;
    case '$item':
    case '$bindItem':
    case '$template':
      if (typeof operand !== 'string') check.issues.push({ path: operandPath, message: `${key} takes a string` });
      return;
    case '$index':
      if (operand !== true) check.issues.push({ path: operandPath, message: '$index takes true' });
      return;
    case '$cond':
      checkCondition(operand, operandPath, check);
      for (const branch of ['$then', '$else']) {
        if (!Object.hasOwn(value, branch)) check.issues.push({ path: pointer(path, branch), message: `a $cond expression needs ${branch}` });
        else if (schema === undefined) checkExpressionsIn(value[branch], pointer(path, branch), check);
        else checkValue(schema, value[branch], pointer(path, branch), check);
      }
      return;
    case '$computed':
      if (typeof operand !== 'string' || !functionNames.has(operand)) check.issues.push({ path: operandPath, message: `unknown function ${JSON.stringify(operand)}; use one of ${[...functionNames].join(', ')}` });
      if (value.args !== undefined && !isRecord(value.args)) check.issues.push({ path: pointer(path, 'args'), message: 'args is an object' });
      else checkExpressionsIn(value.args, pointer(path, 'args'), check);
      return;
  }
}

const COMPARISONS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const CONDITION_SOURCES = ['$state', '$item', '$index'];

function checkCondition(condition: unknown, path: string, check: SpecCheck): void {
  if (typeof condition === 'boolean') return;
  if (Array.isArray(condition)) {
    condition.forEach((item, index) => checkSingleCondition(item, pointer(path, index), check));
    return;
  }
  if (isRecord(condition) && (Object.hasOwn(condition, '$and') || Object.hasOwn(condition, '$or'))) {
    const key = Object.hasOwn(condition, '$and') ? '$and' : '$or';
    const list = condition[key];
    if (Object.keys(condition).length !== 1 || !Array.isArray(list)) {
      check.issues.push({ path, message: `a ${key} condition is { "${key}": [conditions] } with nothing else` });
      return;
    }
    list.forEach((item, index) => checkCondition(item, pointer(pointer(path, key), index), check));
    return;
  }
  checkSingleCondition(condition, path, check);
}

function checkSingleCondition(condition: unknown, path: string, check: SpecCheck): void {
  if (!isRecord(condition)) {
    check.issues.push({ path, message: 'a condition is true, false, { "$state": path, … }, an array of conditions, or { "$and" | "$or": [conditions] }' });
    return;
  }
  const sources = CONDITION_SOURCES.filter((key) => Object.hasOwn(condition, key));
  if (sources.length !== 1) check.issues.push({ path, message: 'a condition reads exactly one of $state, $item or $index' });
  if (Object.hasOwn(condition, '$state')) {
    if (typeof condition.$state === 'string') checkStateRead(condition.$state, pointer(path, '$state'), check);
    else check.issues.push({ path: pointer(path, '$state'), message: '$state takes a state path' });
  }
  if (Object.hasOwn(condition, '$item') && typeof condition.$item !== 'string') check.issues.push({ path: pointer(path, '$item'), message: '$item takes a field name' });
  if (Object.hasOwn(condition, '$index') && condition.$index !== true) check.issues.push({ path: pointer(path, '$index'), message: '$index takes true' });
  const operators = COMPARISONS.filter((key) => Object.hasOwn(condition, key));
  if (operators.length > 1) check.issues.push({ path, message: `use one comparison per condition, not ${operators.join(' and ')}` });
  for (const operator of operators) {
    const operand = condition[operator];
    if (!isRecord(operand)) continue;
    if (typeof operand.$state === 'string' && Object.keys(operand).length === 1) checkStateRead(operand.$state, pointer(pointer(path, operator), '$state'), check);
    else check.issues.push({ path: pointer(path, operator), message: `compare with a literal or {"$state": path}` });
  }
  if (Object.hasOwn(condition, 'not') && typeof condition.not !== 'boolean') check.issues.push({ path: pointer(path, 'not'), message: 'not is true or false' });
  for (const field of Object.keys(condition)) {
    if (!CONDITION_SOURCES.includes(field) && !COMPARISONS.includes(field) && field !== 'not') check.issues.push({ path: pointer(path, field), message: `unknown condition field "${field}"` });
  }
}

function stateSegments(statePath: string): string[] {
  return statePath === '' || statePath === '/' ? [] : statePath.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function isGitSpaceStatePath(statePath: string): boolean {
  const first = stateSegments(statePath)[0];
  return first !== undefined && GITSPACE_STATE_ROOTS.has(first);
}

function readState(state: unknown, statePath: string): unknown {
  let current = state;
  for (const segment of stateSegments(statePath)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** Reports a state read that the seeded state cannot answer; returns whether the path resolves. */
function checkStateRead(statePath: string, path: string, check: SpecCheck): boolean {
  if (statePath !== '' && !statePath.startsWith('/')) {
    check.issues.push({ path, message: `"${statePath}" is not a state path; state paths are JSON pointers such as "/rows/0/label"` });
    return false;
  }
  if (isGitSpaceStatePath(statePath)) return true;
  if (readState(check.state, statePath) !== undefined) return true;
  check.issues.push({ path, message: `"${statePath}" is not in state; seed it in "state"` });
  return false;
}

/** Validates an SVG drawing against GitSpace's allowlist. Issue paths are element positions under the root (`/2/0`). */
export function validateSvg(svg: string): UiBlockIssue[] {
  return parseSvg(svg).issues;
}

/**
 * Parses an SVG drawing and checks it against GitSpace's allowlist. A renderer builds the drawing from `root`, never from
 * the source string, so the tree that was checked is the tree that is drawn. Comments, CDATA, DOCTYPE and processing
 * instructions are refused (only a leading <?xml …?> declaration is skipped): the HTML parser also ends a comment at
 * `--!>` and `<!-->`, so a comment could hide markup from any tokenizer that ends it only at `-->`.
 */
export function parseSvg(svg: string): ParsedSvg {
  const bytes = byteLength(svg);
  if (bytes > MAX_SVG_BYTES) return { root: null, issues: [{ path: '', message: `the SVG is ${bytes} bytes; the limit is ${MAX_SVG_BYTES}` }] };
  const issues: UiBlockIssue[] = [];
  const stack: { node: SvgElementNode; path: string; children: number }[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const declaration = /<\?xml(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*\?>/y;
  let root: SvgElementNode | null = null;
  let roots = 0;
  let index = 0;
  while (index < svg.length) {
    const next = svg.indexOf('<', index);
    const text = svg.slice(index, next === -1 ? svg.length : next);
    const open = stack.at(-1);
    if (open === undefined && text.trim() !== '') issues.push({ path: '', message: 'text outside the <svg> element' });
    else if (open !== undefined && text !== '') open.node.children.push(text.replace(ENTITY, decodeEntity));
    if (next === -1) break;
    const where = open?.path ?? '';
    if (svg.startsWith('<?xml', next) && roots === 0 && svg.slice(0, next).trim() === '') {
      declaration.lastIndex = next;
      if (declaration.exec(svg) === null) {
        issues.push({ path: '', message: 'malformed <?xml …?> declaration; quote every value' });
        break;
      }
      index = declaration.lastIndex;
      continue;
    }
    if (svg.startsWith('<!', next) || svg.startsWith('<?', next)) {
      issues.push({ path: where, message: 'comments, CDATA, DOCTYPE and processing instructions are not allowed' });
      break;
    }
    tag.lastIndex = next;
    const match = tag.exec(svg);
    if (match === null) {
      issues.push({ path: where, message: `malformed tag at offset ${next}; quote every attribute value` });
      break;
    }
    index = tag.lastIndex;
    const [, closing, name, attributes, selfClosing] = match;
    if (closing === '/') {
      const top = stack.pop();
      if (top?.node.name !== name || attributes.trim() !== '' || selfClosing === '/') {
        issues.push({ path: top?.path ?? '', message: top === undefined ? `</${name}> closes nothing` : `</${name}> does not close <${top.node.name}>` });
        break;
      }
      continue;
    }
    const path = open === undefined ? '' : `${open.path}/${open.children++}`;
    const node: SvgElementNode = { name, attributes: checkSvgAttributes(attributes, path, issues), children: [] };
    if (open === undefined) {
      roots += 1;
      root ??= node;
      if (roots > 1) issues.push({ path: '', message: 'an SVG holds one <svg> root element' });
      else if (name !== 'svg') issues.push({ path: '', message: `the root element is <${name}>; it must be <svg>` });
    } else {
      open.node.children.push(node);
    }
    if (!SVG_ELEMENTS.has(name)) issues.push({ path, message: `<${name}> is not allowed; use ${[...SVG_ELEMENTS].join(', ')}` });
    if (selfClosing !== '/') stack.push({ node, path, children: 0 });
  }
  const unclosed = stack.at(-1);
  if (unclosed !== undefined) issues.push({ path: unclosed.path, message: `<${unclosed.node.name}> is not closed` });
  if (roots === 0) issues.push({ path: '', message: 'no <svg> element' });
  return { root, issues };
}

const LOCAL_REFERENCE = /^#[\w.:-]+$/;
const ENTITY = /&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decodeEntity(entity: string, hex: string | undefined, decimal: string | undefined, named: string | undefined): string {
  const code = hex !== undefined ? Number.parseInt(hex, 16) : decimal !== undefined ? Number(decimal) : undefined;
  if (code === undefined) return NAMED_ENTITIES[named ?? ''] ?? entity;
  return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
}

/** Checks a tag's attributes and returns them decoded. */
function checkSvgAttributes(attributes: string, path: string, issues: UiBlockIssue[]): [string, string][] {
  const decoded: [string, string][] = [];
  for (const [, name, doubleQuoted, singleQuoted] of attributes.matchAll(/\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const raw = doubleQuoted ?? singleQuoted ?? '';
    if (raw.replace(ENTITY, '').includes('&')) {
      issues.push({ path, message: `${name}: "&" must start an entity such as &amp;` });
      continue;
    }
    const value = raw.replace(ENTITY, decodeEntity);
    decoded.push([name, value]);
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) issues.push({ path, message: `${name}: event handler attributes are not allowed` });
    else if (lower === 'href' || lower.endsWith(':href')) {
      if (!LOCAL_REFERENCE.test(value.trim())) issues.push({ path, message: `${name}="${value}": only a local "#id" reference is allowed` });
    } else if (lower === 'style') checkSvgStyle(value, path, issues);
    else if (SVG_PAINT_PROPERTIES.has(lower)) checkSvgPaint(lower, value, path, issues);
    if (!lower.startsWith('xmlns')) checkSvgUrls(name, value, path, issues);
  }
  return decoded;
}

function checkSvgStyle(style: string, path: string, issues: UiBlockIssue[]): void {
  if (/@import/i.test(style)) issues.push({ path, message: 'style: @import is not allowed' });
  if (style.includes('\\')) issues.push({ path, message: 'style: CSS escapes are not allowed' });
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (SVG_PAINT_PROPERTIES.has(property)) checkSvgPaint(property, declaration.slice(colon + 1).replace(/!important\s*$/i, ''), path, issues);
  }
}

function checkSvgPaint(property: string, value: string, path: string, issues: UiBlockIssue[]): void {
  const paint = value.trim();
  if (/^(currentcolor|none)$/i.test(paint) || /^var\(--[\w-]+\)$/.test(paint)) return;
  if ((property === 'fill' || property === 'stroke') && /^url\(#[\w.:-]+\)$/.test(paint)) return;
  issues.push({ path, message: `${property}="${paint}": colours are currentColor, none or a theme variable such as var(--foreground)${property === 'fill' || property === 'stroke' ? ', or url(#id)' : ''}` });
}

function checkSvgUrls(name: string, value: string, path: string, issues: UiBlockIssue[]): void {
  const opened = value.match(/url\s*\(/gi)?.length ?? 0;
  const local = [...value.matchAll(/url\(\s*(['"]?)(#[\w.:-]+)\1\s*\)/gi)].length;
  if (opened > local) issues.push({ path, message: `${name}: url() may only name a local "#id"` });
  if (/(?:image-set|src)\s*\(/i.test(value)) issues.push({ path, message: `${name}: image-set() and src() are not allowed` });
}

function renderSchema(schema: z.core.JSONSchema._JSONSchema): string {
  if (typeof schema === 'boolean') return schema ? 'any' : 'never';
  const note = schema.description === undefined ? '' : ` /* ${schema.description} */`;
  return `${renderBareSchema(schema)}${note}`;
}

function renderBareSchema(schema: z.core.JSONSchema.JSONSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined) return schema.enum.filter((value) => value !== null).map((value) => JSON.stringify(value)).join(' | ');
  if (schema.anyOf !== undefined) return schema.anyOf.filter((option) => option.type !== 'null').map(renderSchema).join(' | ');
  const types = (Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type]).filter((type) => type !== 'null');
  if (types.length === 0) return 'any';
  return types.map((type) => {
    if (type === 'object') {
      if (schema.properties !== undefined) {
        const required = schema.required ?? [];
        return `{ ${Object.entries(schema.properties).map(([key, property]) => `${key}${required.includes(key) ? '' : '?'}: ${renderSchema(property)}`).join(', ')} }`;
      }
      return schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean' ? 'object' : `Record<string, ${renderSchema(schema.additionalProperties)}>`;
    }
    if (type === 'array') {
      const item = schema.items === undefined || Array.isArray(schema.items) ? 'any' : renderSchema(schema.items);
      return item.includes(' | ') && !item.startsWith('{') && !item.startsWith('Record<') ? `(${item})[]` : `${item}[]`;
    }
    return type === 'integer' ? 'number' : type;
  }).join(' | ');
}

const EXAMPLE_SPEC = {
  root: 'card',
  elements: {
    card: { type: 'Card', props: { title: 'Which cache keeps the replies?' }, children: ['options'], slots: { footer: ['pick'] } },
    options: { type: 'RadioGroup', props: { label: null, value: { $bindState: '/choice' }, options: { $state: '/options' } }, children: [] },
    pick: { type: 'Button', props: { label: 'Add to message', variant: 'primary', disabled: { $cond: { $state: '/choice', eq: '' }, $then: true, $else: false } }, on: { press: { action: 'stage', params: { kind: 'decision', label: { $computed: 'lookup', args: { items: { $state: '/options' }, key: 'value', value: { $state: '/choice' }, field: 'label' } }, payload: { choice: { $state: '/choice' } } } } }, children: [] },
  },
  state: { choice: '', options: [{ value: 'kv', label: 'Workers KV', description: 'Eventually consistent, cheap reads' }, { value: 'do', label: 'Durable Object', description: 'Strongly consistent, one region' }] },
};

/** What a subagent is told about blocks; the full format is the `gitspace-ui` skill. */
export const UI_BLOCK_SUMMARY = 'GitSpace draws three fenced blocks in Markdown: ```gitspace-ui is ONE JSON object { "root", "elements", "state" }, where "root" names a Card (or an AskCard for one question) in "elements", each element is { "type", "props", "children": [keys] } using only the catalog\'s components and props, and the data it shows sits in "state", read with {"$state": "/path"}; ```svg is one <svg> drawing coloured with currentColor or theme variables; ```mermaid is a Mermaid diagram. GitSpace rejects an invalid block with the path that failed. Read skill://gitspace-ui for the full format before you write a block.';

/** The agent's instructions for writing blocks; the body of the `gitspace-ui` skill. */
export function uiBlockPrompt(): string {
  const fence = '```';
  const componentLines = [...componentByType].map(([name, component]) => {
    const named = component.slots?.filter((slot) => slot !== 'default') ?? [];
    const children = component.slots === undefined ? '' : ` [children${named.length > 0 ? `; slots: ${named.join(', ')}` : ''}]`;
    return `- ${name} ${renderSchema(z.toJSONSchema(component.props, { io: 'input' }))} — ${component.description}${children}`;
  });
  const actionLines = [...actionByName].map(([name, action]) => `- ${name} ${renderSchema(z.toJSONSchema(action.params, { io: 'input' }))} — ${action.description}${Object.hasOwn(builtInActions, name) ? ' (built in)' : ''}`);
  const functionLines = Object.entries(functions).map(([name, fn]) => `- ${name}: ${fn.description}`);
  return `GitSpace draws blocks you write in Markdown. Use one where a picture says it better than prose: numbers side by side, a plan, a before/after, a question with options. Write a sentence or two first, then the block. A chat message may hold several blocks, each placed where it belongs; so may any Markdown you write through a tool (goal, requirement, Change Guide, journal, plan step detail).

Fences (the info string is exactly the fence name):
- ${fence}gitspace-ui: ONE JSON object { "root", "elements", "state" }.
- ${fence}svg: one <svg> drawing (SVG rules below).
- ${fence}mermaid: a Mermaid diagram, at most 16 KiB.

GitSpace checks every block when it is stored. A tool write holding a bad block is rejected with each problem's path, such as \`block 2/elements/table/props/columns/0/align\` (blocks counted in order among these three fences, then a JSON pointer into the spec); fix each one and write again.

## Spec
${fence}gitspace-ui
${JSON.stringify(EXAMPLE_SPEC)}
${fence}
- "root": the key of the root element: a Card, or an AskCard when the block is one question for the person.
- "elements": element key → { "type", "props", "children": [keys], "slots"?: { "<slot>": [keys] }, "visible"?, "repeat"?, "on"? }. Every element has "children" ([] for a leaf). "visible", "repeat" and "on" sit beside "props", never inside it. Put default-slot children in "children", never in slots.default.
- "state": the data the block reads. Seed every path a $state or repeat reads. At most ${MAX_ELEMENTS} elements and ${MAX_SPEC_BYTES / 1024} KiB.

## Components
Props marked ? may be omitted or null; the rest are required.
${componentLines.join('\n')}

## Actions
Bind events with "on": { "<event>": { "action": "<name>", "params": { … } } } or an array of bindings. Events are named in the component descriptions (press, change, answer).
${actionLines.join('\n')}

## Functions, for $computed
${functionLines.join('\n')}

## Expressions
Any prop or action param, or any part of one, may be an expression:
- {"$state": "/path"} reads state. Paths are JSON pointers ("/rows/0/label"; never "/rows.length").
- {"$bindState": "/path"} reads and writes back: input values (value, checked, active).
- {"$cond": <condition>, "$then": <value>, "$else": <value>}.
- {"$template": "Total \${/total} for \${name}"}: "\${/path}" reads state, "\${field}" reads the repeat item.
- {"$computed": "<function>", "args": { … }} calls a function above.
Repeat: "repeat": { "statePath": "/items", "key": "id" } renders the element once and its children once per item. Inside, {"$item": "field"} reads the item ("" for the whole item), {"$index": true} its index, {"$bindItem": "field"} binds an item field; a nested repeat uses "statePath": {"$item": "field"}.
Conditions ("visible" and $cond): true or false; {"$state": "/path"} is truthy; add one of "eq", "neq", "gt", "gte", "lt", "lte" (a literal or {"$state": path}) and/or "not": true; inside a repeat use {"$item": "field"} or {"$index": true} in place of $state; [a, b] means all; {"$and": [...]}, {"$or": [...]}.

## Rules
- Every key in "children" and "slots" names an element in "elements"; no element contains itself.
- Only the components, props, actions and functions above; unknown names and wrong values are rejected.
- Put the data the block shows in "state" and read it with $state, $item and $cond; never repeat a value that state holds.
- A choice the person makes for you (a decision, an answer, a batch to send) uses the stage action: it waits in their message bar so they can add context. Only sign-offs (accept_requirement) act at once.
- GitSpace owns /answered, /staged/<key>, /sent/<key> and /gitspaceNotices: read /answered, /staged and /sent with $state to show progress without seeding them; never write them, and never read /gitspaceNotices.
- SVG (a ${fence}svg block or the Svg component's literal svg string): one <svg> root; only ${[...SVG_ELEMENTS].join(', ')}; every attribute value quoted; no comments, CDATA or DOCTYPE; no script, style, foreignObject or on* attributes; href only a local "#id"; colours (fill, stroke, color, stop-color, also inside style) only currentColor, none or a theme variable such as ${SVG_THEME_VARIABLES.map((name) => `var(${name})`).join(', ')}, and url(#id) for fill and stroke; at most ${MAX_SVG_BYTES / 1024} KiB.`;
}
