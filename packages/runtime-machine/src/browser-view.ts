import { z } from 'zod';
import { boundedText } from './browser-output.js';

const AxValue = z.object({ value: z.unknown().optional() });
const AxNameSource = z.object({ type: z.string(), attribute: z.string().optional(), nativeSource: z.string().optional(), superseded: z.boolean().optional(), invalid: z.boolean().optional(), value: AxValue.optional() });
const AxNode = z.object({
  nodeId: z.string().max(256), parentId: z.string().max(256).optional(), ignored: z.boolean().optional(), backendDOMNodeId: z.number().optional(),
  role: AxValue.optional(), name: z.object({ value: z.unknown(), sources: z.array(AxNameSource).max(256).optional() }).optional(),
  properties: z.array(z.object({ name: z.string(), value: AxValue })).max(256).optional(), childIds: z.array(z.string().max(256)).optional(),
});
/** `Accessibility.getFullAXTree`'s answer; your Chrome adds the document it was read from. */
export const AxTree = z.object({ gitspaceDocument: z.number().int().nonnegative().optional(), nodes: z.array(AxNode) });
type AxNode = z.infer<typeof AxNode>;

/** One line of a page's view, and the element its ref names (a line without a ref names none). */
export type BrowserViewLine = { text: string; ref?: { ref: string; backendNodeId: number } };

/** Roles a person acts on; any other node gets a ref only when it is focusable. */
const ACTIONABLE: Record<string, true> = {
  button: true, link: true, checkbox: true, radio: true, switch: true, textbox: true, searchbox: true, combobox: true, listbox: true,
  option: true, menuitem: true, menuitemcheckbox: true, menuitemradio: true, tab: true, slider: true, spinbutton: true, treeitem: true,
  DisclosureTriangle: true, MenuListOption: true,
};
/** Wrappers that say nothing about the page: shown only when they carry a name or a ref, otherwise their children
 * take their place. */
const TRANSPARENT: Record<string, true> = { generic: true, none: true, presentation: true, LabelText: true, Section: true, paragraph: true, Legend: true, group: true, listitem: true };
/** Structure only, whatever name Chrome derives for it: the page itself and tables used for layout, whose names are
 * just their content run together. */
const STRUCTURAL: Record<string, true> = { RootWebArea: true, LayoutTable: true, LayoutTableRow: true, LayoutTableCell: true };
/** Roles whose level says something (a list item's level is only its nesting, which the indent shows). */
const LEVELED: Record<string, true> = { heading: true, treeitem: true };
/** Text the page shows only through these is never part of a view. */
const HIDDEN: Record<string, true> = { InlineTextBox: true, LineBreak: true };
/** Fields whose content stays out of every view: what is typed into them can be a password, a card, a message. */
const FIELD: Record<string, true> = { textbox: true, searchbox: true, combobox: true, spinbutton: true, slider: true, listbox: true };

function text(value: unknown, bytes: number): string {
  return typeof value === 'string' ? boundedText(value.replace(/\s+/gu, ' ').trim(), bytes) : '';
}

function property(node: AxNode, name: string): unknown {
  return node.properties?.find(entry => entry.name === name)?.value.value;
}

function states(node: AxNode): string {
  const marks: string[] = [];
  const checked = property(node, 'checked');
  if (checked === true || checked === 'true') marks.push('[checked]');
  if (checked === 'mixed') marks.push('[checked=mixed]');
  for (const name of ['disabled', 'expanded', 'selected', 'pressed', 'required']) {
    const value = property(node, name);
    if (value === true || value === 'true') marks.push(`[${name}]`);
  }
  const level = property(node, 'level');
  if (typeof level === 'number' && LEVELED[typeof node.role?.value === 'string' ? node.role.value : '']) marks.push(`[level=${level}]`);
  return marks.map(mark => ` ${mark}`).join('');
}

/** A field's own label, never its content: an aria-label or a label element, as the accessibility tree reports it. */
function fieldLabel(node: AxNode): string {
  const source = node.name?.sources?.find(entry => !entry.superseded && !entry.invalid && typeof entry.value?.value === 'string'
    && ((entry.type === 'attribute' && entry.attribute === 'aria-label')
      || (entry.type === 'relatedElement' && (entry.attribute === 'aria-labelledby' || ['label', 'labelfor', 'labelwrapped'].includes(entry.nativeSource ?? '')))));
  return text(source?.value?.value, 512) || '[form field]';
}

/**
 * The page as an indented outline of what a person sees and can act on, in document order (Playwright's aria snapshot
 * style): `- role "name" [state] [ref=<document>:<node>]`. Only elements one can act on carry refs; text appears as
 * `- text:` lines unless the nearest named element's name already contains it. Nothing typed into a field appears: a field shows its label, and
 * everything inside it (or inside any editable region) is left out.
 */
export function renderBrowserView(nodes: readonly AxNode[], document: string | number): BrowserViewLine[] {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const children = new Map<string, string[]>();
  const listed = new Set<string>();
  for (const node of nodes) if (node.childIds) { children.set(node.nodeId, [...node.childIds]); for (const id of node.childIds) listed.add(id); }
  for (const node of nodes) if (node.parentId && !listed.has(node.nodeId)) {
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.nodeId); else children.set(node.parentId, [node.nodeId]);
    listed.add(node.nodeId);
  }
  const fields = new Set<string>();
  for (const node of nodes) {
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    const editable = property(node, 'editable');
    if (FIELD[role] || (editable !== undefined && editable !== false) || property(node, 'protected') === true) fields.add(node.nodeId);
  }
  const lines: BrowserViewLine[] = [];
  const visited = new Set<string>();
  // Adjacent text at one depth reads as one line ("#", "98", "by" → "# 98 by").
  let joining: { line: BrowserViewLine; indent: string; value: string } | undefined;
  const walk = (id: string, depth: number, parentName: string): void => {
    const node = byId.get(id);
    if (!node || visited.has(id)) return;
    visited.add(id);
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    if (HIDDEN[role]) return;
    const field = fields.has(id);
    const descend = (childDepth: number, name: string) => { if (!field) for (const child of children.get(id) ?? []) walk(child, childDepth, name); };
    if (node.ignored) {
      // An ignored editable region still hides what is typed into it.
      descend(depth, parentName);
      return;
    }
    const indent = '  '.repeat(depth);
    if (role === 'StaticText') {
      const value = text(node.name?.value, 512);
      // Separators ("|", "·") and text the nearest named element's name already contains say nothing.
      if (!value || /^[\p{P}\p{S}]+$/u.test(value) || parentName.includes(value)) return;
      if (joining && joining.indent === indent && lines.at(-1) === joining.line) {
        joining.value = boundedText(`${joining.value} ${value}`, 1024);
        joining.line.text = `${indent}- text: ${JSON.stringify(joining.value)}`;
        return;
      }
      joining = { line: { text: `${indent}- text: ${JSON.stringify(value)}` }, indent, value };
      lines.push(joining.line);
      return;
    }
    const name = field ? fieldLabel(node) : text(node.name?.value, 512);
    const focusable = property(node, 'focusable') === true && !STRUCTURAL[role];
    const ref = node.backendDOMNodeId !== undefined && (ACTIONABLE[role] || focusable) ? { ref: `${document}:${node.backendDOMNodeId}`, backendNodeId: node.backendDOMNodeId } : undefined;
    if (STRUCTURAL[role] || (TRANSPARENT[role] && !name && !ref)) {
      descend(depth, parentName);
      return;
    }
    const line: BrowserViewLine = { text: `${indent}- ${role || 'node'}${name ? ` ${JSON.stringify(name)}` : ''}${states(node)}${ref ? ` [ref=${ref.ref}]` : ''}`, ...(ref ? { ref } : {}) };
    lines.push(line);
    const before = lines.length;
    descend(depth + 1, name || parentName);
    if (lines.length > before) line.text += ':';
  };
  for (const node of nodes) if ((!node.parentId || !byId.has(node.parentId)) && !listed.has(node.nodeId)) walk(node.nodeId, 0, '');
  return lines;
}

/** The bytes of view one result carries. */
export const BROWSER_VIEW_PAGE_BYTES = 24_000;

/** The lines from `offset` that fit one result (at most `limit` lines and `BROWSER_VIEW_PAGE_BYTES`), and where the
 * next page starts (null after the last line). */
export function browserViewPage(lines: readonly BrowserViewLine[], offset: number, limit: number): { lines: BrowserViewLine[]; nextOffset: number | null } {
  const page: BrowserViewLine[] = [];
  let bytes = 0;
  for (const line of lines.slice(offset, offset + limit)) {
    const size = new TextEncoder().encode(line.text).byteLength + 1;
    if (bytes + size > BROWSER_VIEW_PAGE_BYTES) break;
    bytes += size;
    page.push(line);
  }
  const next = offset + page.length;
  return { lines: page, nextOffset: next < lines.length ? next : null };
}
