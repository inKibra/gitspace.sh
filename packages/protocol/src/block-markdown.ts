// Blocks as plain Markdown: what a block's "Copy as Markdown" puts on the clipboard, so a person can paste it into Slack
// or GitHub, and how an agent or a test reads a block as text. Every catalog component has a Markdown form, drawn from
// the spec's state as the block shows it: expressions are read, hidden elements left out and repeats written per item.
// An element whose props fail the catalog's checks, an unknown component and anything that is not a spec are written as
// their title and a JSON code block; blockMarkdown never throws.
import type { z } from 'zod';
import { gitspaceUiCatalog, isRecord, parseBlockRef, parseSvg, readState } from './gitspace-ui.js';
import type { ChangeGuideSection, EvidenceReference, GoalRequirement, JournalEntryView } from './inspector-contract.js';

const components = gitspaceUiCatalog.components;
type Unit = z.output<typeof components.Chart.props>['unit'];

/** Where an element is drawn: the spec's state and, inside a repeat, the item and its index. */
interface Scope { state: unknown; item: unknown; index: number | null }

/** The spec's elements; the keys being drawn and the refs being followed, so nothing draws itself inside itself; and
 * the spec of an element of another block, for a ref this spec does not hold. */
interface Document { elements: Record<string, unknown>; drawing: Set<string>; refs: Set<string>; refSpec: RefSpec | undefined }

/** The spec whose root is the element `ref` names, for a ref to another block of the same document (a message, a
 * goal, a Change Guide); undefined when there is none. */
export type RefSpec = (ref: string) => unknown;

interface Context { document: Document; scope: Scope }

type Draw = (props: unknown, children: readonly string[], context: Context) => string | null;

/** The items of `args.items` whose `args.field` is true. */
function flaggedItems(args: Record<string, unknown>): unknown[] {
  const items = Array.isArray(args.items) ? args.items : [];
  return items.filter((item) => isRecord(item) && item[String(args.field)] === true);
}

function fieldOf(item: unknown, field: unknown): unknown {
  return isRecord(item) && typeof field === 'string' && Object.hasOwn(item, field) ? item[field] : undefined;
}

/** The catalog's `$computed` functions, as the renderer runs them and as Markdown reads them. */
export const blockFunctions: Record<keyof typeof gitspaceUiCatalog.functions, (args: Record<string, unknown>) => unknown> = {
  progress: (args) => `${flaggedItems(args).length} of ${Array.isArray(args.items) ? args.items.length : 0} ${typeof args.noun === 'string' ? args.noun : ''}`.trim(),
  where: flaggedItems,
  pick: (args) => fieldOf(Array.isArray(args.items) && typeof args.index === 'number' ? args.items[args.index] : undefined, args.field),
  lookup: (args) => fieldOf((Array.isArray(args.items) ? args.items : []).find((candidate) => isRecord(candidate) && typeof args.key === 'string' && candidate[args.key] === args.value), args.field),
};

const functionByName = new Map<string, (args: Record<string, unknown>) => unknown>(Object.entries(blockFunctions));

/** An item field; "" is the whole item. */
function itemField(item: unknown, field: string): unknown {
  return field === '' ? item : fieldOf(item, field);
}

function plain(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

/** A value with its expressions read from the scope. */
function resolve(value: unknown, scope: Scope): unknown {
  if (Array.isArray(value)) return value.map((each) => resolve(each, scope));
  if (!isRecord(value)) return value;
  if (typeof value.$state === 'string') return readState(scope.state, value.$state);
  if (typeof value.$bindState === 'string') return readState(scope.state, value.$bindState);
  if (typeof value.$item === 'string') return itemField(scope.item, value.$item);
  if (typeof value.$bindItem === 'string') return itemField(scope.item, value.$bindItem);
  if (value.$index === true) return scope.index ?? undefined;
  if (typeof value.$template === 'string') return value.$template.replace(/\$\{([^}]*)\}/gu, (_, name: string) => plain(name.startsWith('/') ? readState(scope.state, name) : itemField(scope.item, name)));
  if (Object.hasOwn(value, '$cond')) return resolve(holds(value.$cond, scope) ? value.$then : value.$else, scope);
  if (typeof value.$computed === 'string') {
    const compute = functionByName.get(value.$computed);
    const args = resolve(value.args ?? {}, scope);
    return compute && isRecord(args) ? compute(args) : undefined;
  }
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, resolve(each, scope)]));
}

/** Whether a `visible` or `$cond` condition holds in the scope. */
function holds(condition: unknown, scope: Scope): boolean {
  if (typeof condition === 'boolean') return condition;
  if (Array.isArray(condition)) return condition.every((each) => holds(each, scope));
  if (!isRecord(condition)) return false;
  if (Array.isArray(condition.$and)) return condition.$and.every((each) => holds(each, scope));
  if (Array.isArray(condition.$or)) return condition.$or.some((each) => holds(each, scope));
  const source = typeof condition.$state === 'string' ? readState(scope.state, condition.$state)
    : typeof condition.$item === 'string' ? itemField(scope.item, condition.$item)
      : condition.$index === true ? scope.index : undefined;
  const operator = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].find((key) => Object.hasOwn(condition, key));
  const other = operator === undefined ? undefined : resolve(condition[operator], scope);
  const numbers = typeof source === 'number' && typeof other === 'number';
  const result = operator === undefined ? Boolean(source)
    : operator === 'eq' ? source === other
      : operator === 'neq' ? source !== other
        : numbers && (operator === 'gt' ? source > other : operator === 'gte' ? source >= other : operator === 'lt' ? source < other : source <= other);
  return condition.not === true ? !result : result;
}

function bold(text: string): string {
  return `**${text}**`;
}

/** Non-empty parts, as paragraphs. */
function paragraphs(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part) => typeof part === 'string' && part !== '').join('\n\n');
}

/** A fenced code block whose fence is longer than any run of backticks in the body. */
function fenced(language: string, body: string): string {
  const fence = '`'.repeat(Math.max(2, ...(body.match(/`+/gu) ?? []).map((run) => run.length)) + 1);
  return `${fence}${language}\n${body}\n${fence}`;
}

function table(header: readonly string[], rows: readonly (readonly unknown[])[], align: readonly (string | null | undefined)[] = []): string {
  const line = (cells: readonly unknown[]): string => `| ${cells.map((value) => plain(value).replaceAll('|', '\\|').replace(/\r?\n/gu, ' ')).join(' | ')} |`;
  return [line(header), `| ${header.map((_, index) => align[index] === 'right' ? '---:' : '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** A number cut to two decimals, without trailing zeros. */
function round(value: number): string {
  return String(Number.parseFloat(value.toFixed(2)));
}

/** A value in a catalog unit, as a person reads it. */
function amount(value: number, unit: Unit): string {
  if (unit === 'ms') return value >= 1000 ? `${round(value / 1000)} s` : `${round(value)} ms`;
  if (unit === 'seconds') return `${round(value)} s`;
  if (unit === 'percent') return `${round(value)}%`;
  if (unit === 'usd') return `$${round(value)}`;
  if (unit === 'tokens') return `${value.toLocaleString('en-US')} tokens`;
  if (unit !== 'bytes') return value.toLocaleString('en-US');
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let step = 0;
  while (Math.abs(size) >= 1024 && step < sizes.length - 1) {
    size /= 1024;
    step += 1;
  }
  return `${round(size)} ${sizes[step]}`;
}

/** Lines after the first indented, so text of several lines stays inside its list item. */
function indented(text: string): string {
  return text.replace(/\n/gu, '\n  ');
}

/** The change as written in a list: "added", "removed", or nothing for an unchanged part. */
function changed(change: string | null | undefined): string {
  return change && change !== 'same' ? ` (${change})` : '';
}

/** A draw that reads its props with the component's schema; null when they fail it. */
function draw<T>(schema: z.ZodType<T>, render: (props: T, children: readonly string[], context: Context) => string): Draw {
  return (props, children, context) => {
    const read = schema.safeParse(props);
    return read.success ? render(read.data, children, context) : null;
  };
}

/** An element by its id: in this spec, else in another block of the document through `refSpec`, else a note naming it
 * (also for an element of another document). */
function refMarkdown(ref: string, context: Context): string {
  const { document } = context;
  const target = parseBlockRef(ref);
  if (target === null || target.document !== null) return `_(block "${ref}")_`;
  const key = Object.keys(document.elements).find((candidate) => fieldOf(document.elements[candidate], 'id') === target.id);
  if (key !== undefined) return elementMarkdown(key, document, context.scope);
  if (document.refSpec === undefined || document.refs.has(ref)) return `_(block "${ref}")_`;
  document.refs.add(ref);
  const markdown = specMarkdown(document.refSpec(ref), document.refs, document.refSpec);
  document.refs.delete(ref);
  return markdown || `_(block "${ref}")_`;
}

const MARKDOWN: Record<keyof typeof components, Draw> = {
  Card: draw(components.Card.props, (props, children) => paragraphs([props.eyebrow, props.title ? bold(props.title) : null, props.description, ...children])),
  Stack: draw(components.Stack.props, (_, children) => paragraphs(children)),
  Row: draw(components.Row.props, (_, children) => paragraphs(children)),
  Text: draw(components.Text.props, (props) => props.mono ? `\`${props.text}\`` : props.size === 'title' ? bold(props.text) : props.text),
  Markdown: draw(components.Markdown.props, (props) => props.content),
  Badge: draw(components.Badge.props, (props) => bold(props.label)),
  Table: draw(components.Table.props, (props) => paragraphs([props.caption ? bold(props.caption) : null, table(props.columns.map((column) => column.label), props.rows.map((row) => props.columns.map((column) => row[column.key] ?? '')), props.columns.map((column) => column.align))])),
  Stats: draw(components.Stats.props, (props) => props.tiles.map((tile) => `- ${bold(`${tile.label}:`)} ${tile.value}${tile.detail ? ` (${tile.detail})` : ''}`).join('\n')),
  Chart: draw(components.Chart.props, (props) => paragraphs([props.title ? bold(props.title) : null, table(['', ...props.series.map((series) => series.label)], props.rows.map((row) => [row.label, ...props.series.map((series) => {
    const value = row.values[series.key];
    return value === undefined ? '–' : amount(value, props.unit);
  })]), ['left', ...props.series.map(() => 'right')])])),
  Checklist: draw(components.Checklist.props, (props, children) => paragraphs([props.title ? bold(props.title) : null, children.join('\n')])),
  ChecklistItem: draw(components.ChecklistItem.props, (props) => `- [${props.checked ? 'x' : ' '}] ${props.label}${props.note ? ` — ${props.note}` : ''}`),
  Steps: draw(components.Steps.props, (props) => props.steps.map((step, index) => `${index + 1}. ${bold(step.title)}: ${indented(step.detail)}${step.where ? ` (\`${step.where}\`)` : ''}`).join('\n')),
  Switch: draw(components.Switch.props, (props) => `- [${props.checked ? 'x' : ' '}] ${props.label}`),
  Segmented: draw(components.Segmented.props, (props) => props.options.map((option) => option.value === props.value ? bold(option.label) : option.label).join(' · ')),
  RadioGroup: draw(components.RadioGroup.props, (props) => paragraphs([props.label ? bold(props.label) : null, props.options.map((option) => `- [${option.value === props.value ? 'x' : ' '}] ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')])),
  TextField: draw(components.TextField.props, (props) => `${bold(`${props.label}:`)} ${props.value}`),
  // A button acts on the block; copied text has nothing to press.
  Button: draw(components.Button.props, () => ''),
  Diff: draw(components.Diff.props, (props) => paragraphs([props.title ? bold(props.title) : null, fenced('diff', props.patch)])),
  CodeExcerpt: draw(components.CodeExcerpt.props, (props) => {
    const extension = /\.([A-Za-z0-9]+)$/u.exec(props.path)?.[1]?.toLowerCase() ?? '';
    const last = props.startLine + props.lines.length - 1;
    return paragraphs([
      `\`${props.path}\` lines ${props.startLine}–${last}${props.commit ? ` at ${props.commit.slice(0, 7)}` : ''}`,
      fenced(extension, props.lines.join('\n')),
      props.highlight?.length ? `Marked: line${props.highlight.length > 1 ? 's' : ''} ${props.highlight.join(', ')}` : null,
      props.note,
    ]);
  }),
  CommandRun: draw(components.CommandRun.props, (props) => paragraphs([
    `\`${props.command.replace(/\s*\n\s*/gu, ' ')}\`: exit ${props.exitCode} (${props.exitCode === 0 ? 'passed' : 'failed'}) in ${amount(props.durationMs, 'ms')}${props.cwd ? `, in \`${props.cwd}\`` : ''}`,
    props.output === '' ? null : fenced('text', props.output),
    props.truncated ? '_(the end of a longer output)_' : null,
  ])),
  TestReport: draw(components.TestReport.props, (props) => {
    const count = (value: number | null, label: string): string | null => value === null ? null : `${value} ${label}`;
    const counts = [count(props.passed, 'passed'), count(props.failed, 'failed'), count(props.skipped, 'skipped')].filter((part) => part !== null).join(', ');
    return paragraphs([
      `${bold(`Tests${props.runner ? ` (${props.runner})` : ''}:`)} ${counts || 'no counts'}${props.durationMs === null || props.durationMs === undefined ? '' : ` in ${amount(props.durationMs, 'ms')}`}`,
      props.failures.length > 0 ? `Failures:\n${props.failures.map((failure) => `- ${bold(failure.name)}${failure.file ? ` (\`${failure.file}\`)` : ''}: ${indented(failure.message)}`).join('\n')}` : null,
      props.flaky?.length ? `Flaky: ${props.flaky.join(', ')}` : null,
      props.note,
    ]);
  }),
  ChangeSet: draw(components.ChangeSet.props, (props) => {
    const added = props.files.reduce((sum, file) => sum + file.added, 0);
    const removed = props.files.reduce((sum, file) => sum + file.removed, 0);
    const line = (path: string): string => {
      const file = props.files.find((candidate) => candidate.path === path);
      return file ? `- \`${file.path}\` ${file.binary ? 'binary' : `+${file.added} −${file.removed}`} (${file.status})` : '';
    };
    const grouped = new Set(props.groups?.flatMap((group) => group.paths) ?? []);
    const rest = props.files.filter((file) => !grouped.has(file.path)).map((file) => file.path);
    const sections = [...(props.groups ?? []).map((group) => ({ name: group.name, paths: group.paths })), ...(rest.length > 0 ? [{ name: props.groups?.length ? 'Other' : null, paths: rest }] : [])];
    return paragraphs([
      `${bold('Changes')}${props.base ? ` against \`${props.base}\`` : ''}${props.head ? ` on \`${props.head}\`` : ''}: ${props.files.length} file${props.files.length === 1 ? '' : 's'}, +${added} −${removed}`,
      ...sections.map((section) => [section.name ? bold(section.name) : null, ...section.paths.map(line)].filter((part) => part !== null).join('\n')),
    ]);
  }),
  RunTag: draw(components.RunTag.props, (props) => `_${[props.commit, props.machine, props.sample].join(' · ')}${props.label ? `: ${props.label}` : ''}_`),
  BeforeAfter: draw(components.BeforeAfter.props, (props) => paragraphs([props.before, props.after].map((pane) => paragraphs([bold(`${pane.label}${pane.title ? `: ${pane.title}` : ''}`), pane.body])))),
  AskCard: draw(components.AskCard.props, (props) => paragraphs([
    bold(props.question),
    props.prompt.trim() === props.question.trim() ? null : props.prompt,
    props.options.map((option) => `- ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n'),
    props.answered ? `Answered: ${props.answered}` : null,
  ])),
  Svg: draw(components.Svg.props, (props) => {
    const title = parseSvg(props.svg).root?.children.find((child) => typeof child !== 'string' && child.name === 'title');
    const text = title && typeof title !== 'string' ? title.children.filter((child) => typeof child === 'string').join('').trim() : '';
    return text ? `(diagram) ${text}` : '(diagram)';
  }),
  Mermaid: draw(components.Mermaid.props, (props) => fenced('mermaid', props.source)),
  FlowMap: draw(components.FlowMap.props, (props) => {
    const name = (id: string): string => props.areas.find((area) => area.id === id)?.name ?? id;
    const walk = props.steps?.length ? props.steps.map((step) => `${bold(name(step.from))} → ${bold(name(step.to))}: ${step.caption}`)
      : props.paths.map((path) => `${bold(name(path.from))} → ${bold(name(path.to))}: ${path.label}${changed(path.state)}`);
    return walk.map((step, index) => `${index + 1}. ${step}`).join('\n');
  }),
  Roadmap: draw(components.Roadmap.props, (props) => paragraphs(props.phases.map((phase) => [
    `${bold(phase.title)} (${phase.status}${phase.when ? `, ${phase.when}` : ''})${phase.note ? `: ${phase.note}` : ''}`,
    ...phase.items.map((item) => {
      const refs = (item.refs ?? []).map((ref) => 'pr' in ref ? `PR #${ref.pr}` : 'issue' in ref ? `#${ref.issue}` : `workspace \`${ref.workspace}\``);
      const status = item.status && item.status !== 'done' && item.status !== 'todo' ? ` (${item.status})` : '';
      const decide = item.decide ? `; decide: ${item.decide.question} (${item.decide.options.join(' / ')})` : '';
      return `- [${item.status === 'done' ? 'x' : ' '}] ${item.label}${status}${refs.length > 0 ? `: ${refs.join(', ')}` : ''}${decide}`;
    }),
  ].join('\n')))),
  CallDiff: draw(components.CallDiff.props, (props) => paragraphs([
    props.title ? bold(props.title) : null,
    fenced('diff', props.lines.map((line) => `${line.change === 'added' ? '+' : line.change === 'removed' ? '-' : ' '} ${'  '.repeat(line.depth)}${line.code}${line.note ? `  # ${line.note}` : ''}`).join('\n')),
  ])),
  StateFlow: draw(components.StateFlow.props, (props) => {
    const name = (id: string): string => props.services.find((service) => service.id === id)?.name ?? id;
    return paragraphs([
      props.title ? bold(props.title) : null,
      props.steps.map((step, index) => {
        const sets = step.sets?.length ? ` Sets ${step.sets.map((set) => `${name(set.service)}.${set.key} = ${set.value}`).join(', ')}.` : '';
        return `${index + 1}. ${bold(name(step.from))} → ${bold(name(step.to))}: \`${step.label}\`${changed(step.change)}. ${step.caption}${sets}`;
      }).join('\n'),
    ]);
  }),
  MetricDelta: draw(components.MetricDelta.props, (props) => table(['Metric', 'Before', 'After', 'Change'], props.metrics.map((metric) => {
    const percent = metric.before === 0 ? null : (metric.after - metric.before) / Math.abs(metric.before) * 100;
    const better = metric.after === metric.before ? 'same' : (metric.after < metric.before) === (metric.better === 'lower') ? 'better' : 'worse';
    return [metric.label, amount(metric.before, metric.unit), amount(metric.after, metric.unit), `${percent === null ? '' : `${percent > 0 ? '+' : ''}${round(percent)}% `}(${better})`];
  }), ['left', 'right', 'right', 'right'])),
  LogTable: draw(components.LogTable.props, (props) => paragraphs([
    props.title ? bold(props.title) : null,
    fenced('text', props.lines.map((line) => `${line.highlight ? '> ' : '  '}${[line.at, line.level.toUpperCase(), line.source ? `[${line.source}]` : null, line.text].filter(Boolean).join(' ')}${line.repeat ? ` (×${line.repeat})` : ''}`).join('\n')),
  ])),
  Timeline: draw(components.Timeline.props, (props) => {
    const time = (at: string): number => Number.isNaN(Date.parse(at)) ? 0 : Date.parse(at);
    const events = props.events.map((event, index) => ({ event, index })).sort((a, b) => time(a.event.at) - time(b.event.at) || a.index - b.index);
    return paragraphs([props.title ? bold(props.title) : null, events.map(({ event }) => `- ${bold(event.at)} ${event.kind}: ${event.label}${event.detail ? `. ${event.detail}` : ''}`).join('\n')]);
  }),
  Tradeoffs: draw(components.Tradeoffs.props, (props) => paragraphs([
    bold(props.question),
    table(['', ...props.options.map((option) => option.id === props.recommended ? `${option.label} (recommended)` : option.label)], props.criteria.map((criterion) => [
      criterion.note ? `${criterion.label} (${criterion.note})` : criterion.label, ...props.options.map((_, column) => `${criterion.scores[column] ?? 0}/3`),
    ])),
    props.recommended ? `Recommended: ${bold(props.options.find((option) => option.id === props.recommended)?.label ?? props.recommended)}` : null,
    props.note,
  ])),
  CheckGrid: draw(components.CheckGrid.props, (props) => paragraphs([props.title ? bold(props.title) : null, table(['', ...props.columns], props.rows.map((row) => [row.label, ...props.columns.map((_, column) => row.cells[column] ?? 'none')]))])),
  SchemaDiff: draw(components.SchemaDiff.props, (props) => paragraphs([props.title ? bold(props.title) : null, ...props.tables.map((schema) => {
    const facts = [schema.change, schema.renamedFrom ? `renamed from \`${schema.renamedFrom}\`` : null, schema.rows, schema.cost && schema.cost !== 'none' ? `cost: ${schema.cost}` : null].filter(Boolean).join(', ');
    const columns = schema.columns.filter((column) => column.change !== 'same').map((column) => {
      const facts = [column.key, column.nullable ? 'nullable' : null, column.references ? `→ ${column.references}` : null, column.renamedFrom ? `renamed from \`${column.renamedFrom}\`` : null].filter(Boolean).join(', ');
      const type = column.change === 'changed' && column.typeFrom ? `${column.typeFrom} → ${column.type}` : column.type;
      return `- ${column.change} \`${column.name}\` ${type}${facts ? ` (${facts})` : ''}${column.note ? `: ${column.note}` : ''}`;
    });
    const indexes = (schema.indexes ?? []).filter((index) => index.change !== 'same').map((index) => `- ${index.change} ${index.unique ? 'unique ' : ''}index \`${index.name}\` (${index.columns.join(', ')})`);
    return [`${bold(schema.name)} (${facts})`, ...columns, ...indexes].join('\n');
  })])),
  WorkspaceGraph: draw(components.WorkspaceGraph.props, (props) => props.workspaces.map((each) => `- \`${each.workspace}\`${each.dependsOn?.length ? `, depends on ${each.dependsOn.map((other) => `\`${other}\``).join(', ')}` : ''}${each.note ? `: ${each.note}` : ''}`).join('\n')),
  Rank: draw(components.Rank.props, (props) => paragraphs([bold(props.question), props.items.map((item, index) => `${index + 1}. ${item.label}`).join('\n')])),
  Budget: draw(components.Budget.props, (props) => {
    const used = props.days.reduce((sum, day) => sum + day.used, 0);
    return paragraphs([`${bold(`${props.label}:`)} ${amount(used, props.unit)} of ${amount(props.limit, props.unit)} used, ${amount(Math.max(0, props.limit - used), props.unit)} left`, table(['Day', 'Used'], props.days.map((day) => [day.day, amount(day.used, props.unit)]), ['left', 'right'])]);
  }),
  BlockRef: draw(components.BlockRef.props, (props, _, context) => refMarkdown(props.id, context)),
  Image: draw(components.Image.props, (props) => paragraphs([`![${props.alt}](${props.src})`, props.caption ? `_${props.caption}_` : null])),
  Video: draw(components.Video.props, (props) => paragraphs([`[Video: ${props.alt}](${props.src})`, props.caption ? `_${props.caption}_` : null])),
  Sequence: draw(components.Sequence.props, (props, _, context) => paragraphs([bold(props.title), ...props.frames.map((frame, index) => {
    const content = typeof frame.content.ref === 'string' ? refMarkdown(frame.content.ref, context) : drawElement(frame.content, context.document, context.scope);
    const voice = frame.say ?? frame.caption;
    return paragraphs([bold(`${index + 1}.`), content, voice ? `> ${voice}` : null]);
  })])),
  Reply: draw(components.Reply.props, (props) => paragraphs([props.quote ? `> ${props.quote}` : null, props.text])),
};

const drawByType = new Map<string, Draw>(Object.entries(MARKDOWN));

/** JSON as a code block under its title; a value JSON cannot hold is written as text. */
function jsonBlock(title: string, value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  return paragraphs([bold(title), fenced('json', json)]);
}

function elementMarkdown(key: string, document: Document, scope: Scope): string {
  const element = document.elements[key];
  if (document.drawing.has(key) || !isRecord(element)) return '';
  document.drawing.add(key);
  const markdown = drawElement(element, document, scope);
  document.drawing.delete(key);
  return markdown;
}

/** One element: its children (once per item under a repeat), then the component's Markdown around them. */
function drawElement(element: Record<string, unknown>, document: Document, scope: Scope): string {
  if (element.visible !== undefined && !holds(element.visible, scope)) return '';
  const keys = [element.children, ...(isRecord(element.slots) ? Object.values(element.slots) : [])].flatMap((list) => Array.isArray(list) ? list.filter((key) => typeof key === 'string') : []);
  const children: string[] = [];
  const repeat = isRecord(element.repeat) ? element.repeat : null;
  const items = repeat === null ? null : typeof repeat.statePath === 'string' ? readState(scope.state, repeat.statePath) : resolve(repeat.statePath, scope);
  if (Array.isArray(items)) items.forEach((item, index) => { for (const key of keys) children.push(elementMarkdown(key, document, { state: scope.state, item, index })); });
  else for (const key of keys) children.push(elementMarkdown(key, document, scope));
  const props = resolve(element.props, scope);
  const markdown = typeof element.type === 'string' ? drawByType.get(element.type)?.(props, children.filter((child) => child !== ''), { document, scope }) : null;
  if (markdown !== null && markdown !== undefined) return markdown;
  const named = isRecord(props) ? [props.title, props.question, props.label].find((value) => typeof value === 'string' && value !== '') : undefined;
  return jsonBlock(typeof named === 'string' ? named : typeof element.type === 'string' ? element.type : 'Block', element);
}

/** A spec's root as Markdown; '' when `spec` is not a spec or draws nothing. A ref back to its root is not followed. */
function specMarkdown(spec: unknown, refs: Set<string>, refSpec: RefSpec | undefined): string {
  if (!isRecord(spec) || !isRecord(spec.elements) || typeof spec.root !== 'string') return '';
  const id = fieldOf(spec.elements[spec.root], 'id');
  if (typeof id === 'string') refs.add(id);
  return elementMarkdown(spec.root, { elements: spec.elements, drawing: new Set(), refs, refSpec }, { state: spec.state ?? {}, item: undefined, index: null });
}

/**
 * A gitspace-ui spec ({ root, elements, state }, as `fenceSpec` reads a fence) as plain Markdown. A short-form fence and
 * its full form read the same. `refSpec` finds the elements of other blocks a BlockRef or a Sequence frame names.
 */
export function blockMarkdown(spec: unknown, refSpec?: RefSpec): string {
  try {
    const markdown = specMarkdown(spec, new Set(), refSpec);
    if (markdown !== '') return markdown;
  } catch {
    // A value no spec holds (a cycle, a getter that throws) is written as JSON below.
  }
  return jsonBlock('Block', spec);
}

// The typed record blocks (`Requirement`, `Decision`, `Evidence`, `GuideSection`) as plain Markdown, drawn from their
// records. Like blockMarkdown, they never throw.

/** One line naming an evidence reference: its label and what it points at. */
export function evidenceMarkdown(reference: EvidenceReference): string {
  switch (reference.kind) {
    case 'artifact': return `**${reference.label}**: artifact \`${reference.url}\` (\`${reference.hash}\`)`;
    case 'git': return `**${reference.label}**: \`${reference.path}\` @ \`${reference.commitId.slice(0, 7)}\``;
    case 'command': return `**${reference.label}**: run \`${reference.runId}\`, exit code ${reference.exitCode}`;
    case 'review-thread': return `**${reference.label}**: review thread \`${reference.threadId}\`${reference.messageId === null ? '' : `, message \`${reference.messageId}\``}`;
    default: return '';
  }
}

const REQUIREMENT_STATUS: Readonly<Record<string, string>> = { accepted: 'accepted', review: 'evidence to check', missing: 'no evidence' };

/** A requirement as a task-list item: checked once accepted, its status, whether it is optional, its description and
 * its evidence. */
export function requirementMarkdown(requirement: GoalRequirement): string {
  const marks = [REQUIREMENT_STATUS[requirement.status] ?? requirement.status, ...(requirement.required ? [] : ['optional'])];
  const lines = [`- [${requirement.status === 'accepted' ? 'x' : ' '}] **${requirement.title}** (${marks.join(', ')})`];
  if (requirement.description.trim() !== '') lines.push('', `  ${indented(requirement.description.trim())}`);
  const evidence = requirement.evidence ?? [];
  if (evidence.length > 0) lines.push('', ...evidence.map((reference) => `  - ${evidenceMarkdown(reference)}`));
  return lines.join('\n');
}

/** A decision entry: its title (struck through, and what replaced it, once superseded), who wrote it and when, its body,
 * the messages it quotes and the decision it replaces. */
export function decisionMarkdown(entry: JournalEntryView, replacedBy: string | null): string {
  const parts = [replacedBy === null ? `### ${entry.title}` : `### ~~${entry.title}~~\n\nSuperseded by ${replacedBy}.`];
  parts.push(`*${entry.createdBy}, ${entry.createdAt}*`);
  if (entry.body.trim() !== '') parts.push(entry.body.trim());
  for (const citation of entry.citations ?? []) {
    parts.push(`${citation.quote.split('\n').map((line) => `> ${line}`).join('\n')}\n>\n> — ${citation.who}, ${citation.at}`);
  }
  if (entry.supersedes !== undefined) parts.push(`Supersedes ${entry.supersedes}.`);
  return parts.join('\n\n');
}

const CALLOUT_LABELS: Readonly<Record<string, string>> = { risk: 'Risk', mechanical: 'Mechanical', decision: 'Decision' };

/** A guide section, numbered as the guide reads: its title and kind, summary, explanation, why, callouts, diagram (its
 * fence kept), exhibits with their line ranges and notes, and evidence. */
export function guideSectionMarkdown(section: ChangeGuideSection, number: number): string {
  const parts = [`### §${number} ${section.title}`, `*${section.kind}*`];
  for (const text of [section.summary, section.explanation]) if (text !== undefined && text.trim() !== '') parts.push(text.trim());
  if (section.why.trim() !== '') parts.push(`**Why:** ${section.why.trim()}`);
  for (const callout of section.callouts ?? []) parts.push(`> **${CALLOUT_LABELS[callout.tone] ?? callout.tone}:** ${callout.text.split('\n').join('\n> ')}`);
  if (section.diagram !== undefined && section.diagram.trim() !== '') parts.push(section.diagram.trim());
  if (section.exhibits.length > 0) {
    parts.push(section.exhibits.map((exhibit) => [
      `- \`${exhibit.path}\`${exhibit.note.trim() === '' ? '' : `: ${exhibit.note.trim()}`}`,
      ...(exhibit.ranges ?? []).map((range) => `  - lines ${range.start}–${range.end}${range.note === undefined || range.note === '' ? '' : `: ${range.note}`}`),
    ].join('\n')).join('\n'));
  }
  const evidence = section.evidence ?? [];
  if (evidence.length > 0) parts.push(['**Evidence**', ...evidence.map((reference) => `- ${evidenceMarkdown(reference)}`)].join('\n'));
  return parts.join('\n\n');
}
