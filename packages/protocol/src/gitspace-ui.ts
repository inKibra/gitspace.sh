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
/** Something in the project a block names, drawn as a live chip: a pull request with its state and checks, an issue, or a
 * workspace with its status, each opening it. */
const reference = z.union([
  z.strictObject({ pr: z.number().int().positive() }),
  z.strictObject({ issue: z.number().int().positive() }),
  z.strictObject({ workspace: z.string().min(1).max(200).describe('A workspace id in this project') }),
]);
export type UiReference = z.infer<typeof reference>;
/** An element's `id`: a BlockRef or a Sequence frame names it to draw that element again. Unique within its document. */
const BLOCK_ID = /^[A-Za-z0-9][\w.-]{0,63}$/u;
const BLOCK_ID_RULE = 'an id is 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit';
/** A reference to a block element: its id in this document, or `<document>#<id>` for an element of another document. */
const BLOCK_REF = /^(?:([\w.:/-]{1,200})#)?([A-Za-z0-9][\w.-]{0,63})$/u;
const BLOCK_REF_RULE = 'a ref is the "id" of a block element in this document, or "<document>#<id>" for another document';
const blockRef = z.string().regex(BLOCK_REF, BLOCK_REF_RULE);
/** An element's `ask`: what it asks of the person. A required ask is an open question until they answer it through the
 * block's own choice; an optional one is only an invitation. */
const askSchema = z.strictObject({
  required: z.boolean().describe('true: an open question the person must answer; false: only an invitation'),
  prompt: z.string().min(1).max(300).nullish().describe('One line: what you ask'),
});
export type UiAsk = z.infer<typeof askSchema>;
/** Where a picture or clip lives: a drive file or a browser capture. */
const mediaSource = z.string().regex(/^(?:drive:\/\/(?:workspace|base)\/\S+|capture:[\w-]{1,128})$/u, 'src is a drive file (drive://workspace/… or drive://base/…) or a browser capture (capture:<id>)');
const FRAME_CONTENT_SHAPE = 'content is one element { "type", "props", "children" } as in "elements", or { "ref": "<block id>" }';

/** A block reference split: `document` is null for an element of the same document. Null when `ref` is not one. */
export function parseBlockRef(ref: string): { document: string | null; id: string } | null {
  const match = BLOCK_REF.exec(ref);
  return match ? { document: match[1] ?? null, id: match[2] } : null;
}

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
      kind: z.enum(['bars', 'columns', 'line', 'stacked']).nullish().describe('bars (default): one group of horizontal bars per row; columns: the same as vertical bars; line: one line per series across the rows in order, for values over time or over a sequence; stacked: one horizontal bar per row, its series stacked, for parts of a total'),
      unit: z.enum(['ms', 'seconds', 'count', 'percent', 'bytes', 'usd', 'tokens']),
      series: z.array(z.strictObject({ key: z.string(), label: z.string(), color })),
      rows: z.array(z.strictObject({ label: z.string(), values: z.record(z.string(), z.number()).describe('series key → value') })),
      max: z.number().nullish(),
    }),
    description: `Numbers drawn to scale. Values are in \`unit\`: ms show as seconds, bytes as KB, MB or GB, usd as dollars. A series color is a name, one of ${color.options.join(', ')}; never a hex value.`,
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
  FlowMap: {
    props: z.strictObject({
      areas: z.array(z.strictObject({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(80),
        group: z.string().min(1).max(80).describe('The package, service or layer the area belongs to; areas of one group are drawn together'),
        role: z.string().max(200).nullish().describe('One line: what the area is'),
        note: z.string().max(400).nullish().describe('What it does in this flow, shown when the area is opened'),
      })).min(1).max(32),
      paths: z.array(z.strictObject({
        id: z.string().min(1).max(64),
        from: z.string().describe('An area id'),
        to: z.string().describe('An area id'),
        label: z.string().max(160).describe('What travels along it: a call, an event, a write'),
        state: z.enum(['added', 'removed', 'same']).describe('added: a path this change makes; removed: one it takes away; same: one it keeps'),
      })).max(64),
      steps: z.array(z.strictObject({
        paths: z.array(z.string()).min(1).describe('Path ids lit in this step'),
        from: z.string().describe('An area id'),
        to: z.string().describe('An area id'),
        caption: z.string().max(400),
      })).max(16).nullish().describe('A walk through the flow, played one step at a time'),
    }),
    description: 'How code or data flows between parts of a system, drawn as the Change Guide draws a change: areas grouped by package, paths between them marked added, removed or unchanged, and optional steps that light the paths in order. Use it for how a request travels, what a change rewires, or an architecture.',
  },
  Roadmap: {
    props: z.strictObject({
      phases: z.array(z.strictObject({
        title: z.string().min(1).max(60),
        when: z.string().max(40).nullish().describe('When it lands: a version, "next release", a date'),
        status: z.enum(['done', 'active', 'next', 'later', 'blocked']),
        note: z.string().max(120).nullish().describe('One short line: what the phase achieves'),
        items: z.array(z.strictObject({
          label: z.string().min(1).max(80).describe('A few words; the refs carry the detail'),
          status: z.enum(['done', 'active', 'todo', 'blocked', 'needs-you']).nullish(),
          refs: z.array(reference).max(6).nullish(),
          decide: z.strictObject({ question: z.string().min(1).max(120), options: z.array(z.string().min(1).max(40)).min(2).max(4) }).nullish()
            .describe('A call the person makes on this item: each option stages "Decided: <option>" in their message bar'),
        })).max(10),
      })).min(1).max(8),
    }),
    description: 'Work in phases, in order: shipped, now, next, later. Each phase has a status, a short note and items; each item has a status and refs ({ "pr": 1434 }, { "issue": 1452 }, { "workspace": "<id>" }) drawn as live chips that open them, and a `decide` when the person must make a call on it. Use it for a release plan, a migration in stages, or work grouped by stage.',
  },
  CallDiff: {
    props: z.strictObject({
      title: z.string().max(120).nullish(),
      language: z.enum(['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'ruby', 'sql', 'shell']).nullish().describe('Highlights the code; typescript when omitted'),
      lines: z.array(z.strictObject({
        depth: z.number().int().min(0).max(12).describe('Nesting: a call inside the call above is one deeper'),
        code: z.string().min(1).max(200).describe('One line of code: an assignment, a call, a return'),
        change: z.enum(['added', 'removed', 'same']),
        note: z.string().max(120).nullish().describe('Why this line matters, shown as a comment'),
        path: z.string().max(300).nullish().describe('The repository file it lives in; the line opens it'),
      })).min(1).max(60),
    }),
    description: 'A call stack before and after a change: the calls one request makes, nested by depth, with removed calls red and added ones green, each with a short note. Use it to show what a change does to a code path, in place of a long diff.',
  },
  StateFlow: {
    props: z.strictObject({
      title: z.string().max(120).nullish(),
      services: z.array(z.strictObject({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(60),
        role: z.string().max(80).nullish(),
        parent: z.string().nullish().describe('A service id this one is drawn inside'),
        change: z.enum(['added', 'removed', 'same']).nullish(),
        state: z.array(z.strictObject({ key: z.string().min(1).max(40), value: z.string().max(60) })).max(4).nullish().describe('What it holds before the first step'),
      })).min(1).max(12),
      steps: z.array(z.strictObject({
        from: z.string(),
        to: z.string(),
        label: z.string().min(1).max(60).describe('The call or message that travels, e.g. create(alice)'),
        change: z.enum(['added', 'removed', 'same']).nullish(),
        caption: z.string().max(240),
        sets: z.array(z.strictObject({ service: z.string(), key: z.string(), value: z.string().max(60) })).max(6).nullish().describe('State that changes when this step lands'),
      })).min(1).max(16),
    }),
    description: 'Services and the state each holds, played one step at a time: a call travels from service to service and the state it changes updates. Removed services and calls are struck through, added ones green. Use it for how state moves through a system and what a change does to it.',
  },
  MetricDelta: {
    props: z.strictObject({
      metrics: z.array(z.strictObject({
        label: z.string().min(1).max(60),
        before: z.number(),
        after: z.number(),
        unit: z.enum(['ms', 'seconds', 'count', 'percent', 'bytes', 'usd', 'tokens']),
        better: z.enum(['lower', 'higher']),
        trend: z.array(z.number()).max(40).nullish().describe('Recent values, oldest first, drawn as a sparkline'),
      })).min(1).max(8),
    }),
    description: 'Numbers that changed: before → after with the change in percent, green when it moved the better way and red when it got worse, with an optional sparkline.',
  },
  LogTable: {
    props: z.strictObject({
      title: z.string().max(120).nullish(),
      lines: z.array(z.strictObject({
        at: z.string().max(40).nullish().describe('A time as the log shows it'),
        level: z.enum(['debug', 'info', 'warn', 'error']),
        source: z.string().max(40).nullish(),
        text: z.string().min(1).max(400),
        repeat: z.number().int().min(2).nullish().describe('How many times this line repeated'),
        highlight: z.boolean().nullish().describe('The line that matters'),
      })).min(1).max(80),
    }),
    description: 'Log lines as an investigation reads them: level colors, repeats folded into a count, and the lines that matter highlighted.',
  },
  Timeline: {
    props: z.strictObject({
      title: z.string().max(120).nullish(),
      events: z.array(z.strictObject({
        at: z.string().describe('ISO time'),
        kind: z.enum(['deploy', 'error', 'alert', 'fix', 'note']),
        label: z.string().min(1).max(60),
        detail: z.string().max(240).nullish(),
      })).min(1).max(40),
    }),
    description: 'Events on a time axis, colored by kind: deploys, errors, alerts and fixes. Use it for an incident, a release day or a run.',
  },
  Tradeoffs: {
    props: z.strictObject({
      question: z.string().min(1).max(160),
      options: z.array(z.strictObject({ id: z.string().min(1).max(40), label: z.string().min(1).max(60) })).min(2).max(5),
      criteria: z.array(z.strictObject({ label: z.string().min(1).max(60), scores: z.array(z.number().int().min(0).max(3)).describe('One per option: 0 poor to 3 strong'), note: z.string().max(120).nullish() })).min(1).max(8),
      recommended: z.string().nullish().describe('The option id you recommend'),
    }),
    description: 'Options scored against criteria as a colored grid, the recommended one marked. The person picks an option; it stages as their decision.',
  },
  CheckGrid: {
    props: z.strictObject({
      title: z.string().max(120).nullish(),
      columns: z.array(z.string().min(1).max(30)).min(1).max(12),
      rows: z.array(z.strictObject({ label: z.string().min(1).max(60), cells: z.array(z.enum(['pass', 'fail', 'running', 'skip', 'none'])) })).min(1).max(40),
    }),
    description: 'Checks as a grid: suites or jobs by platform, branch or run, each cell pass, fail, running or skipped.',
  },
  SchemaDiff: {
    props: z.strictObject({
      title: z.string().max(120).nullish(),
      tables: z.array(z.strictObject({
        name: z.string().min(1).max(60),
        renamedFrom: z.string().max(60).nullish(),
        change: z.enum(['added', 'removed', 'changed', 'same']),
        rows: z.string().max(40).nullish().describe('Its size, e.g. "1.2M rows"'),
        cost: z.enum(['none', 'lock', 'rewrite', 'backfill']).nullish().describe('What the migration does to it: an exclusive lock, a full rewrite, or a backfill of rows'),
        columns: z.array(z.strictObject({
          name: z.string().min(1).max(60),
          type: z.string().max(40),
          change: z.enum(['added', 'removed', 'changed', 'same']),
          renamedFrom: z.string().max(60).nullish(),
          typeFrom: z.string().max(40).nullish().describe('The type before, when it changed'),
          key: z.enum(['primary', 'unique']).nullish(),
          nullable: z.boolean().nullish(),
          references: z.string().max(120).nullish().describe('table.column a foreign key points at'),
          note: z.string().max(120).nullish(),
        })).max(30),
        indexes: z.array(z.strictObject({ name: z.string().min(1).max(80), columns: z.array(z.string()).min(1).max(8), change: z.enum(['added', 'removed', 'same']), unique: z.boolean().nullish() })).max(12).nullish(),
      })).min(1).max(12),
    }),
    description: 'Tables a migration adds, removes or changes: columns with types (old type struck beside the new), renames, keys and foreign keys (drawn as links between tables), indexes, row counts, and what it costs (lock, rewrite, backfill).',
  },
  WorkspaceGraph: {
    props: z.strictObject({
      workspaces: z.array(z.strictObject({ workspace: z.string().min(1), dependsOn: z.array(z.string()).max(8).nullish(), note: z.string().max(80).nullish() })).min(1).max(20),
    }),
    description: 'Workspaces and what each depends on, laid out left to right in dependency order, each with its live status; a workspace opens on click.',
  },
  Rank: {
    props: z.strictObject({
      question: z.string().min(1).max(160),
      items: z.array(z.strictObject({ id: z.string().min(1).max(40), label: z.string().min(1).max(80) })).min(2).max(12),
    }),
    description: 'Items the person puts in order by dragging; the order stages as their decision.',
  },
  Budget: {
    props: z.strictObject({
      label: z.string().min(1).max(60),
      unit: z.enum(['usd', 'tokens', 'count']),
      limit: z.number().positive(),
      days: z.array(z.strictObject({ day: z.string().max(20), used: z.number().nonnegative() })).min(1).max(31),
    }),
    description: 'Spend against a limit: the total used and left, and use per day as bars, the days over the daily pace marked.',
  },
  BlockRef: {
    props: z.strictObject({ id: blockRef.describe('The "id" of a block element in this document, or "<document>#<id>"') }),
    description: 'Draws again the block element whose "id" this is, from the same document (this message, this Change Guide, this goal), with its own state. Use it to show a block again next to a new point, never to copy it.',
  },
  Image: {
    props: z.strictObject({
      src: mediaSource,
      alt: z.string().min(1).max(200).describe('What the image shows, for someone who cannot see it'),
      caption: z.string().max(300).nullish(),
    }),
    description: 'A picture from the drive or a browser capture, inline; it opens full size.',
  },
  Video: {
    props: z.strictObject({
      src: mediaSource,
      alt: z.string().min(1).max(200).describe('What the clip shows'),
      caption: z.string().max(300).nullish(),
      poster: mediaSource.nullish().describe('An image shown before the clip plays'),
      start: z.number().min(0).nullish().describe('Seconds: play from here'),
      end: z.number().positive().nullish().describe('Seconds: stop here'),
    }),
    description: 'A clip from the drive or a browser capture, played inline with its controls; `start` and `end` play only that part. It opens full-screen.',
  },
  Sequence: {
    props: z.strictObject({
      title: z.string().min(1).max(120),
      frames: z.array(z.strictObject({
        content: z.record(z.string(), z.unknown()).describe('One element { "type", "props", "children" } as in "elements" (its children name keys in "elements"), or { "ref": "<block id>" } to show a block of this document again'),
        say: z.string().min(1).max(400).nullish().describe('The voice line: one or two plain sentences saying what to look at'),
        caption: z.string().min(1).max(400).nullish().describe('The subtitle; the say line when omitted'),
        hold: z.number().min(0.5).max(60).nullish().describe('Seconds the frame stays at least'),
      })).min(2).max(30),
    }),
    description: 'A narrated walkthrough played like a short video: one frame at a time, each with a voice line (`say`) the person hears and reads as a subtitle. It shows frame 1 as a still with a play button and never plays by itself; the person steps through, changes speed or mutes. A frame lasts its speech, its `hold`, or 4 s without a voice. Each frame shows one thing: Markdown, Svg, Mermaid, CallDiff, StateFlow, Image, Video or any component except a Sequence, or a block of this document by { "ref": "<id>" }. Write 2 to 30 frames, one point each, in the order you would explain it.',
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

/** Validates every block in Markdown. Issue paths start with `block <n>` (1-based, counting only these fences). The
 * Markdown is one document: an element id is used once in it, and a ref to an element of this document names one. */
export function validateMarkdownBlocks(markdown: string): UiBlockIssue[] {
  const issues: UiBlockIssue[] = [];
  const owners = new Map<string, number>();
  const refs: { ref: string; block: number; path: string }[] = [];
  extractBlocks(markdown).forEach((block, index) => {
    const checked = checkBlock(block);
    for (const found of checked.issues) issues.push({ path: `block ${index + 1}${found.path}`, message: found.message });
    for (const [id, path] of checked.ids) {
      const owner = owners.get(id);
      if (owner === undefined) owners.set(id, index);
      else if (owner !== index) issues.push({ path: `block ${index + 1}${path}`, message: `id "${id}" is also used by block ${owner + 1}; an id is used once in a document` });
    }
    for (const found of checked.refs) refs.push({ ...found, block: index });
  });
  for (const { ref, block, path } of refs) {
    const target = parseBlockRef(ref);
    if (target !== null && target.document === null && !owners.has(target.id)) {
      issues.push({ path: `block ${block + 1}${path}`, message: `no block element with id "${target.id}" in this document${owners.size > 0 ? `; its ids are ${[...owners.keys()].join(', ')}` : ''}` });
    }
  }
  return issues;
}

/** The ids, refs and issues of one fenced block. */
interface CheckedBlock {
  issues: UiBlockIssue[];
  ids: ReadonlyMap<string, string>;
  refs: readonly { ref: string; path: string }[];
}

function checkBlock(block: UiBlock): CheckedBlock {
  if (block.kind !== 'gitspace-ui' || !block.closed) return { issues: validateBlock(block), ids: new Map(), refs: [] };
  let spec: unknown;
  try {
    spec = JSON.parse(block.body);
  } catch {
    return { issues: validateBlock(block), ids: new Map(), refs: [] };
  }
  return checkSpec(spec);
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
  /** Element id → the path that declared it. */
  ids: Map<string, string>;
  /** The block refs the spec draws: BlockRef ids and Sequence frame refs. */
  refs: { ref: string; path: string }[];
}

/** Validates a gitspace-ui spec. Issue paths are JSON pointers into the spec. */
export function validateUiSpec(spec: unknown): UiBlockIssue[] {
  return checkSpec(spec).issues;
}

function checkSpec(spec: unknown): SpecCheck {
  const check: SpecCheck = { state: {}, issues: [], ids: new Map(), refs: [] };
  if (!isRecord(spec)) return { ...check, issues: [{ path: '', message: 'a gitspace-ui spec is one JSON object { "root", "elements", "state" }' }] };
  let bytes: number;
  try {
    bytes = byteLength(JSON.stringify(spec));
  } catch {
    return { ...check, issues: [{ path: '', message: 'the spec is not JSON' }] };
  }
  if (bytes > MAX_SPEC_BYTES) return { ...check, issues: [{ path: '', message: `the spec is ${bytes} bytes; the limit is ${MAX_SPEC_BYTES}` }] };
  check.state = spec.state ?? {};
  for (const key of Object.keys(spec)) {
    if (key !== 'root' && key !== 'elements' && key !== 'state') check.issues.push({ path: pointer('', key), message: `unknown field "${key}"; a spec has root, elements and state` });
  }
  if (spec.state !== undefined && !isRecord(spec.state)) check.issues.push({ path: '/state', message: 'state is an object' });
  const { root, elements } = spec;
  if (typeof root !== 'string') check.issues.push({ path: '/root', message: 'root is the key of the root element' });
  if (!isRecord(elements)) {
    check.issues.push({ path: '/elements', message: 'elements is an object mapping each element key to its element' });
    return check;
  }
  const keys = Object.keys(elements);
  if (keys.length > MAX_ELEMENTS) {
    check.issues.push({ path: '/elements', message: `the spec has ${keys.length} elements; the limit is ${MAX_ELEMENTS}` });
    return check;
  }
  if (typeof root === 'string' && !Object.hasOwn(elements, root)) check.issues.push({ path: '/root', message: `no element "${root}" in elements` });
  for (const key of keys) validateElement(elements, key, check);
  if (typeof root === 'string' && Object.hasOwn(elements, root)) findCycles(elements, root, check.issues);
  return check;
}

/** A required ask of a block element: the element's id, what it asks, and the choices the block offers for it. */
export interface RequiredBlockAsk { id: string; prompt: string; choices: string[] }

/** Actions whose button stages or gives the person's answer: its label is one of the block's choices. */
const CHOICE_ACTIONS: Record<string, true> = { stage: true, answer_question: true, record_decision: true };

/** The durable question a required block ask posts: one per message and element id. */
export function blockAskQuestionId(messageId: string, blockId: string): string {
  return `block-ask:${messageId}:${blockId}`;
}

/** The required asks of the gitspace-ui blocks in Markdown, in order; a block that fails the checks asks nothing. */
export function requiredBlockAsks(markdown: string): RequiredBlockAsk[] {
  const asks: RequiredBlockAsk[] = [];
  for (const block of extractBlocks(markdown)) {
    if (block.kind !== 'gitspace-ui' || !block.closed) continue;
    let spec: unknown;
    try {
      spec = JSON.parse(block.body);
    } catch {
      continue;
    }
    if (!isRecord(spec) || !isRecord(spec.elements) || checkSpec(spec).issues.length > 0) continue;
    const { elements, state = {} } = spec;
    for (const element of Object.values(elements)) {
      if (!isRecord(element) || typeof element.id !== 'string' || !isRecord(element.ask) || element.ask.required !== true) continue;
      const choices: string[] = [];
      let asked: string | null = null;
      const seen = new Set<string>();
      const visit = (node: Record<string, unknown>): void => {
        const props = isRecord(node.props) ? node.props : {};
        if (asked === null && node.type === 'AskCard' && typeof props.question === 'string') asked = props.question;
        const options = isRecord(props.options) && typeof props.options.$state === 'string' ? readState(state, props.options.$state) : props.options;
        if (Array.isArray(options)) {
          for (const choice of options) if (isRecord(choice) && typeof choice.label === 'string') choices.push(choice.label);
        }
        // A button that stages a literal label gives that label; one whose label is computed from a pick adds nothing.
        const press = isRecord(node.on) ? node.on.press : undefined;
        const params = isRecord(press) && typeof press.action === 'string' && CHOICE_ACTIONS[press.action] && isRecord(press.params) ? press.params : null;
        const given = params === null ? null : typeof params.label === 'string' ? params.label : typeof params.choice === 'string' ? params.choice : null;
        if (node.type === 'Button' && given !== null) choices.push(given);
        for (const child of childReferences(node)) {
          const next = elements[child.key];
          if (seen.has(child.key) || !isRecord(next)) continue;
          seen.add(child.key);
          visit(next);
        }
      };
      visit(element);
      const props = isRecord(element.props) ? element.props : {};
      const titled = typeof props.question === 'string' ? props.question : typeof props.title === 'string' ? props.title : null;
      const prompt = typeof element.ask.prompt === 'string' ? element.ask.prompt : asked ?? titled ?? `Answer the block "${element.id}"`;
      asks.push({ id: element.id, prompt, choices: [...new Set(choices)] });
    }
  }
  return asks;
}

const ELEMENT_FIELDS = new Set(['type', 'props', 'children', 'slots', 'visible', 'repeat', 'on', 'watch', 'id', 'ask']);

/** Issue paths inside a Sequence frame's content. A renderer draws the rest of the Sequence and an error card in that
 * frame, so one bad frame does not hide the walkthrough. */
export const SEQUENCE_FRAME_CONTENT_PATH = /^\/elements\/[^/]+\/props\/frames\/\d+\/content(?:\/|$)/u;

function validateElement(elements: Record<string, unknown>, key: string, check: SpecCheck): void {
  checkElement(elements, elements[key], pointer('/elements', key), check);
}

/**
 * Checks one Sequence frame's content as validateUiSpec checks it, against the spec's elements and state. A renderer
 * draws the error card in the frame's place when this has issues. Issue paths start at the content.
 */
export function validateFrameContent(content: unknown, elements: Record<string, unknown>, state: unknown): UiBlockIssue[] {
  if (!isRecord(content)) return [{ path: '', message: FRAME_CONTENT_SHAPE }];
  const check: SpecCheck = { state, issues: [], ids: new Map(), refs: [] };
  checkFrameContent(elements, content, '', check);
  return check.issues;
}

function checkFrameContent(elements: Record<string, unknown>, content: Record<string, unknown>, path: string, check: SpecCheck): void {
  if (Object.hasOwn(content, 'ref')) {
    if (Object.keys(content).length !== 1) check.issues.push({ path, message: 'a ref frame is { "ref": "<block id>" } with nothing else' });
    if (typeof content.ref === 'string' && BLOCK_REF.test(content.ref)) check.refs.push({ ref: content.ref, path: pointer(path, 'ref') });
    else check.issues.push({ path: pointer(path, 'ref'), message: BLOCK_REF_RULE });
    return;
  }
  if (content.type === 'Sequence') check.issues.push({ path: pointer(path, 'type'), message: 'a Sequence frame cannot hold another Sequence' });
  if (content.ask !== undefined) check.issues.push({ path: pointer(path, 'ask'), message: 'an ask belongs on a block element, not inside a Sequence frame' });
  if (content.id !== undefined) check.issues.push({ path: pointer(path, 'id'), message: 'an id belongs on a block element; give it there and show it here with { "ref": "<id>" }' });
  const nested = childReferences(content).find((child) => {
    const element = elements[child.key];
    return isRecord(element) && element.type === 'Sequence';
  });
  if (nested !== undefined) check.issues.push({ path: `${path}${nested.path}`, message: 'a Sequence frame cannot hold another Sequence' });
  checkElement(elements, content, path, check);
}

function checkElement(elements: Record<string, unknown>, element: unknown, path: string, check: SpecCheck): void {
  if (!isRecord(element)) {
    check.issues.push({ path, message: 'an element is an object { type, props, children }' });
    return;
  }
  for (const field of Object.keys(element)) {
    if (!ELEMENT_FIELDS.has(field)) check.issues.push({ path: pointer(path, field), message: `unknown element field "${field}"; an element has ${[...ELEMENT_FIELDS].join(', ')}` });
  }
  if (element.id !== undefined) {
    const idPath = pointer(path, 'id');
    const declared = typeof element.id === 'string' ? check.ids.get(element.id) : undefined;
    if (typeof element.id !== 'string' || !BLOCK_ID.test(element.id)) check.issues.push({ path: idPath, message: BLOCK_ID_RULE });
    else if (declared !== undefined) check.issues.push({ path: idPath, message: `id "${element.id}" is already used at ${declared}; an id is used once in a document` });
    else check.ids.set(element.id, idPath);
  }
  if (element.ask !== undefined) {
    checkValue(askSchema, element.ask, pointer(path, 'ask'), check);
    if (isRecord(element.ask) && element.ask.required === true && element.id === undefined) check.issues.push({ path: pointer(path, 'ask'), message: 'a required ask needs an "id" on its element, so GitSpace can track the answer' });
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
    const { frames, start, end, id } = element.props;
    if (type === 'Sequence' && Array.isArray(frames)) {
      frames.forEach((frame, index) => {
        if (isRecord(frame) && isRecord(frame.content)) checkFrameContent(elements, frame.content, pointer(pointer(pointer(propsPath, 'frames'), index), 'content'), check);
      });
    } else if (type === 'BlockRef' && typeof id === 'string' && BLOCK_REF.test(id)) {
      check.refs.push({ ref: id, path: pointer(propsPath, 'id') });
    } else if (type === 'Video' && typeof start === 'number' && typeof end === 'number' && end <= start) {
      check.issues.push({ path: pointer(propsPath, 'end'), message: `end (${end} s) is not after start (${start} s)` });
    } else if (type === 'Svg' && typeof element.props.svg === 'string') {
      for (const found of validateSvg(element.props.svg)) check.issues.push({ path: `${pointer(propsPath, 'svg')}${found.path}`, message: found.message });
    } else if (type === 'Svg' && element.props.svg !== undefined) {
      check.issues.push({ path: pointer(propsPath, 'svg'), message: 'svg is one literal <svg> string, never an expression' });
    } else if (type === 'Mermaid' && typeof element.props.source === 'string') {
      for (const found of validateMermaid(element.props.source)) check.issues.push({ path: pointer(propsPath, 'source'), message: found.message });
    } else if (type === 'FlowMap' && !hasExpression(element.props)) {
      const map = components.FlowMap.props.safeParse(element.props);
      if (map.success) checkFlowMapReferences(map.data, propsPath, check.issues);
    }
  }
  checkElementChildren(elements, element, path, component, check.issues);
  if (element.visible !== undefined) checkCondition(element.visible, pointer(path, 'visible'), check);
  if (element.repeat !== undefined) checkRepeat(element.repeat, pointer(path, 'repeat'), check);
  if (element.on !== undefined) checkBindings(element.on, pointer(path, 'on'), check);
  if (element.watch !== undefined) checkBindings(element.watch, pointer(path, 'watch'), check);
}

/** A FlowMap's ids are unique, its paths join areas it has, and its steps light paths and areas it has. */
function checkFlowMapReferences(map: z.infer<typeof components.FlowMap.props>, path: string, issues: UiBlockIssue[]): void {
  const at = (...keys: (string | number)[]): string => keys.reduce<string>(pointer, path);
  const areas = new Set<string>();
  map.areas.forEach((area, index) => {
    if (areas.has(area.id)) issues.push({ path: at('areas', index, 'id'), message: `area id "${area.id}" is used twice` });
    areas.add(area.id);
  });
  const known = (id: string, where: string): void => { if (!areas.has(id)) issues.push({ path: where, message: `no area "${id}"; the areas are ${[...areas].join(', ')}` }); };
  const paths = new Set<string>();
  map.paths.forEach((flow, index) => {
    if (paths.has(flow.id)) issues.push({ path: at('paths', index, 'id'), message: `path id "${flow.id}" is used twice` });
    paths.add(flow.id);
    known(flow.from, at('paths', index, 'from'));
    known(flow.to, at('paths', index, 'to'));
  });
  map.steps?.forEach((step, index) => {
    known(step.from, at('steps', index, 'from'));
    known(step.to, at('steps', index, 'to'));
    step.paths.forEach((id, position) => { if (!paths.has(id)) issues.push({ path: at('steps', index, 'paths', position), message: `no path "${id}"` }); });
  });
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
      const attempt: SpecCheck = { ...check, issues: [] };
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

/** A worked example in the `gitspace-ui` skill: when to draw it and the block itself. Every example passes
 * `validateMarkdownBlocks` (tested), so the skill never teaches a block GitSpace would reject. */
export interface UiBlockExample { title: string; when: string; fence: UiBlockKind; body: string }

const spec = (value: Record<string, unknown>): string => JSON.stringify(value);

export const UI_BLOCK_EXAMPLES: readonly UiBlockExample[] = [
  {
    title: 'Results of a run',
    when: 'You measured something: the headline numbers as Stats, the comparison as a Chart, and where the numbers came from as a RunTag.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: 'Cold start after the cache change', description: 'Median of 20 runs per build' }, children: ['tiles', 'chart', 'run'] },
        tiles: { type: 'Stats', props: { tiles: { $state: '/tiles' } }, children: [] },
        chart: { type: 'Chart', props: { kind: 'columns', unit: 'ms', series: { $state: '/series' }, rows: { $state: '/rows' } }, children: [] },
        run: { type: 'RunTag', props: { commit: '4f2c9a1', machine: 'darktop', sample: 'n=20', label: 'scripts/bench-cold.ts' }, children: [] },
      },
      state: {
        tiles: [{ label: 'p50', value: '1.8 s', detail: 'was 3.1 s', tone: 'good' }, { label: 'p95', value: '2.6 s', detail: 'was 4.4 s', tone: 'good' }, { label: 'Memory', value: '92 MB', detail: 'was 88 MB', tone: 'neutral' }],
        series: [{ key: 'before', label: 'Before', color: 'gray' }, { key: 'after', label: 'After', color: 'green' }],
        rows: [{ label: 'p50', values: { before: 3100, after: 1800 } }, { label: 'p95', values: { before: 4400, after: 2600 } }],
      },
    }),
  },
  {
    title: 'Values over time',
    when: 'A measure that changes over time or over a sequence (memory per turn, latency per release): a line Chart, one line per series.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: 'Memory per turn', description: 'The workspace object resets at 128 MB' }, children: ['chart'] },
        chart: { type: 'Chart', props: { kind: 'line', unit: 'bytes', series: { $state: '/series' }, rows: { $state: '/rows' }, max: 134217728 }, children: [] },
      },
      state: {
        series: [{ key: 'read', label: 'Read per turn', color: 'blue' }, { key: 'held', label: 'Held after the turn', color: 'violet' }],
        rows: [{ label: 'turn 1', values: { read: 31457280, held: 8388608 } }, { label: 'turn 2', values: { read: 32505856, held: 9437184 } }, { label: 'migrated', values: { read: 11534336, held: 4194304 } }, { label: 'turn 4', values: { read: 11665408, held: 4194304 } }],
      },
    }),
  },
  {
    title: 'Options compared',
    when: 'Several options against the same properties: a Table, the recommended one named in the text before it.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: 'Where replies are cached' }, children: ['table'] },
        table: { type: 'Table', props: { columns: { $state: '/columns' }, rows: { $state: '/rows' }, caption: 'Reads measured from the worker in the same region' }, children: [] },
      },
      state: {
        columns: [{ key: 'store', label: 'Store' }, { key: 'read', label: 'Read', align: 'right', mono: true }, { key: 'consistency', label: 'Consistency' }, { key: 'cost', label: 'Cost / month', align: 'right', mono: true }],
        rows: [{ store: 'Workers KV', read: '4 ms', consistency: 'eventual, up to 60 s', cost: '$5' }, { store: 'Durable Object', read: '11 ms', consistency: 'strong', cost: '$12' }, { store: 'D1', read: '19 ms', consistency: 'strong', cost: '$5' }],
      },
    }),
  },
  {
    title: 'How it flows',
    when: 'How a request travels, what a change rewires, an architecture: a FlowMap, as the Change Guide draws a change. Areas grouped by package; paths added, removed or kept; steps that walk the flow.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: 'Where a codemode child\'s output goes now' }, children: ['map'] },
        map: {
          type: 'FlowMap', children: [], props: {
            areas: [
              { id: 'script', name: 'codemode script', group: 'runtime-core', role: 'Runs the agent\'s script and its child calls' },
              { id: 'tool', name: 'tool execute', group: 'runtime-core', role: 'Runs one tool call and keeps its output' },
              { id: 'store', name: 'tool-result store', group: 'runtime-workspace-do', role: 'Whole outputs, read on demand' },
              { id: 'entries', name: 'conversation entries', group: 'pi-durable', role: 'What every turn reads back' },
            ],
            paths: [
              { id: 'call', from: 'script', to: 'tool', label: 'child call', state: 'same' },
              { id: 'full', from: 'tool', to: 'entries', label: 'whole output (up to 50 KB)', state: 'removed' },
              { id: 'stub', from: 'tool', to: 'entries', label: '1 KB stub and reference', state: 'added' },
              { id: 'keep', from: 'tool', to: 'store', label: 'whole output', state: 'added' },
              { id: 'back', from: 'store', to: 'script', label: 'output for the script', state: 'added' },
            ],
            steps: [
              { paths: ['call'], from: 'script', to: 'tool', caption: 'The script calls a tool.' },
              { paths: ['keep', 'stub'], from: 'tool', to: 'store', caption: 'The whole output goes to the store; the entry keeps a stub.' },
              { paths: ['back'], from: 'store', to: 'script', caption: 'The script reads the whole output from the store.' },
            ],
          },
        },
      },
      state: {},
    }),
  },
  {
    title: 'A choice for the person',
    when: 'The person picks for you: stage the choice in their message bar, so they can add context before it is sent.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'card',
      elements: {
        card: { type: 'Card', id: 'cache-choice', ask: { required: true, prompt: 'Which cache keeps the replies?' }, props: { title: 'Which cache keeps the replies?' }, children: ['options'], slots: { footer: ['pick'] } },
        options: { type: 'RadioGroup', props: { label: null, value: { $bindState: '/choice' }, options: { $state: '/options' } }, children: [] },
        pick: { type: 'Button', props: { label: 'Add to message', variant: 'primary', disabled: { $cond: { $state: '/choice', eq: '' }, $then: true, $else: false } }, on: { press: { action: 'stage', params: { kind: 'decision', label: { $computed: 'lookup', args: { items: { $state: '/options' }, key: 'value', value: { $state: '/choice' }, field: 'label' } }, payload: { choice: { $state: '/choice' } } } } }, children: [] },
      },
      state: { choice: '', options: [{ value: 'kv', label: 'Workers KV', description: 'Eventually consistent, cheap reads' }, { value: 'do', label: 'Durable Object', description: 'Strongly consistent, one region' }] },
    }),
  },
  {
    title: 'A plan to tick off',
    when: 'Steps or checks the person goes through: a Checklist repeated over state, its progress in the card, and the ticked items staged for you.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: 'Before the release', description: { $computed: 'progress', args: { items: { $state: '/checks' }, field: 'done', noun: 'checks done' } } }, children: ['list'], slots: { footer: ['send'] } },
        list: { type: 'Checklist', props: { title: null }, repeat: { statePath: '/checks', key: 'id' }, children: ['item'] },
        item: { type: 'ChecklistItem', props: { index: { $index: true }, label: { $item: 'label' }, checked: { $bindItem: 'done' }, note: { $item: 'note' } }, children: [] },
        send: { type: 'Button', props: { label: 'Add to message', variant: 'primary' }, on: { press: { action: 'stage', params: { kind: 'review', label: { $computed: 'progress', args: { items: { $state: '/checks' }, field: 'done', noun: 'checks done' } }, payload: { done: { $computed: 'where', args: { items: { $state: '/checks' }, field: 'done' } } } } } }, children: [] },
      },
      state: { checks: [{ id: 'tests', label: 'Suites pass', done: true, note: '826 tests' }, { id: 'smoke', label: 'Smoke run on the release', done: false, note: '' }, { id: 'live', label: 'Checked live in the workspace', done: false, note: '' }] },
    }),
  },
  {
    title: 'Before and after',
    when: 'What changes for someone: two panes of Markdown, with a slider when they overlay.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: 'The board in the transcript' }, children: ['compare'] },
        compare: { type: 'BeforeAfter', props: { before: { label: 'Before', title: 'A message from you', body: 'The board arrived as **your** chat bubble.' }, after: { label: 'After', title: 'A notice', body: 'A quiet *Workspace board* row; **Show all** opens the full board.' }, slider: false }, children: [] },
      },
      state: {},
    }),
  },
  {
    title: 'A layout or anything the components cannot express',
    when: 'Layout, geometry, a UI mockup, a custom diagram: an svg block. Size it with viewBox; colour it only with currentColor and theme variables.',
    fence: 'svg',
    body: '<svg viewBox="0 0 360 150" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="358" height="148" rx="8" fill="none" stroke="var(--border)"/><rect x="1" y="1" width="96" height="148" rx="8" fill="var(--surface-2)"/><text x="14" y="26" font-size="12" fill="var(--muted-foreground)">Projects</text><text x="14" y="48" font-size="12" fill="currentColor">core</text><rect x="114" y="16" width="230" height="56" rx="6" fill="none" stroke="var(--accent)"/><text x="126" y="40" font-size="12" fill="currentColor">Workspace board</text><text x="126" y="58" font-size="11" fill="var(--muted-foreground)">one line per workspace</text><rect x="114" y="84" width="230" height="50" rx="6" fill="none" stroke="var(--border)"/><text x="126" y="113" font-size="12" fill="var(--muted-foreground)">Composer</text></svg>',
  },
  {
    title: 'Mermaid, only for the most basic flow',
    when: 'A handful of boxes in a line, or when the work is already about Mermaid (a Mermaid file, a diagram someone wrote in Mermaid). Anything more is a FlowMap or SVG.',
    fence: 'mermaid',
    body: 'flowchart LR\n  push[Push to develop] --> launch[Launch] --> live[Live]',
  },
  {
    title: 'A walkthrough to play',
    when: 'A change or an incident explained in order, as a short narrated video: a Sequence. One point per frame, a plain voice line each; give a block you show again an "id" and name it with { "ref" }.',
    fence: 'gitspace-ui',
    body: spec({
      root: 'page',
      elements: {
        page: { type: 'Stack', props: { gap: 'md' }, children: ['times', 'walk'] },
        times: { type: 'Stats', id: 'read-times', props: { tiles: [{ label: 'Read', value: '11 ms', detail: 'was 4 ms', tone: 'bad' }, { label: 'Stale replies', value: '0', detail: 'was 3 a day', tone: 'good' }] }, children: [] },
        walk: {
          type: 'Sequence', id: 'cache-walkthrough', ask: { required: false, prompt: 'Tell me which frame is unclear and I redraw it.' }, children: [], props: {
            title: 'Where a reply is cached now',
            frames: [
              { content: { type: 'Markdown', props: { content: '**Replies are cached in a Durable Object**, not in Workers KV.' }, children: [] }, say: 'Replies are cached in one Durable Object now, not in Workers KV.' },
              { content: { type: 'Mermaid', props: { source: 'flowchart LR\n  worker --> cache[(Durable Object)] --> reply' }, children: [] }, say: 'The worker asks the object first; only a miss goes to the model.', hold: 5 },
              { content: { ref: 'read-times' }, say: 'Reads are seven milliseconds slower, and no reply is stale any more.' },
            ],
          },
        },
      },
      state: {},
    }),
  },
];

/** Every agent's instruction about blocks, main agents and subagents alike; the `gitspace-ui` skill has the format. */
export const UI_BLOCK_BRIEF = 'Drawing: GitSpace renders blocks you write in Markdown, in chat and in every Markdown field (goal, journal, Change Guide). Draw when a picture says it better than prose: results and measurements (Stats tiles, a Chart, a MetricDelta, a RunTag naming the run), options compared (a Table, Tradeoffs), values over time (a line Chart), how code or data flows or what a change rewires (a FlowMap, drawn as the Change Guide draws a change; a CallDiff, a StateFlow), a plan to tick off (a Checklist), a choice for the person (a card that stages it in their message bar; give it an id and a required ask when you need the answer), before and after (BeforeAfter), a change explained in order as a short narrated video (a Sequence of frames, each with a voice line). Use ```svg for layout, geometry, mockups or anything the components cannot express, and ```mermaid only for the most basic flows or when the work is already about Mermaid. Before you write a block, read skill://gitspace-ui: it has the format, every component and worked examples. GitSpace rejects an invalid block with the path that failed; fix it and write again.';

/** The skill's description: what an agent sees in a skill list, so it names the moments to read the skill. */
export const UI_SKILL_DESCRIPTION = 'Draw what you show as blocks GitSpace renders: cards, charts, tables, FlowMaps, checklists, SVG. Read before you report numbers or a measurement, compare options, explain how code or data flows, lay out a plan, show a before and after, or ask the person to choose.';

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
  const examples = UI_BLOCK_EXAMPLES.map((example) => `### ${example.title}\n${example.when}\n${fence}${example.fence}\n${example.body}\n${fence}`).join('\n\n');
  return `GitSpace draws blocks you write in Markdown: in chat replies and in any Markdown you write through a tool (goal, requirement, Change Guide, journal, plan step detail). Write a sentence or two first, then the block; one idea per block, and never draw the same content twice.

## Which block
- Results of a run or a measurement: Stats for the headline numbers, a Chart for the comparison, a RunTag for where they came from.
- Options compared on the same properties: a Table.
- Values over time or over a sequence: a Chart with kind "line". Parts of a total: kind "stacked".
- How code or data flows, what a change rewires, an architecture: a FlowMap.
- A plan or checks the person goes through: a Checklist.
- A choice the person makes for you: a card whose button stages the choice; an AskCard for one question. Give it an "id" and a required "ask" when you need the answer before you go on.
- Numbers that moved: MetricDelta. A spend against a limit: Budget.
- A call path a change rewires, line by line: CallDiff. State moving between services, step by step: StateFlow. A migration's tables: SchemaDiff.
- An investigation: LogTable for the log lines, Timeline for the events. Checks by platform or run: CheckGrid.
- Options scored against criteria for the person to pick: Tradeoffs. Items the person puts in order: Rank.
- Work in phases with its PRs and issues: Roadmap. Workspaces and what each waits on: WorkspaceGraph.
- A change or an incident explained in order, to be played like a short narrated video: a Sequence.
- A picture or a clip from the drive or a browser capture: Image, Video.
- Before and after: BeforeAfter.
- Layout, geometry, a UI mockup, or a drawing the components cannot express: ${fence}svg.
- ${fence}mermaid only for the most basic flow (a handful of boxes in a line), or when the work is already about Mermaid. Anything more is a FlowMap or SVG.

## Fences
The info string is exactly the fence name.
- ${fence}gitspace-ui: ONE JSON object { "root", "elements", "state" }.
- ${fence}svg: one <svg> drawing (SVG rules below).
- ${fence}mermaid: a Mermaid diagram, at most 16 KiB.

GitSpace checks every block when it is stored. A tool write holding a bad block is rejected with each problem's path, such as \`block 2/elements/table/props/columns/0/align\` (blocks counted in order among these three fences, then a JSON pointer into the spec); fix each one and write again.

## Examples
Each passes GitSpace's checks; copy their shape.

${examples}

## Spec
- "root": the key of the root element: a Card, an AskCard when the block is one question for the person, or a Sequence.
- "elements": element key → { "type", "props", "children": [keys], "slots"?: { "<slot>": [keys] }, "visible"?, "repeat"?, "on"?, "id"?, "ask"? }. Every element has "children" ([] for a leaf). "visible", "repeat", "on", "id" and "ask" sit beside "props", never inside it. Put default-slot children in "children", never in slots.default.
- "state": the data the block reads. Seed every path a $state or repeat reads. At most ${MAX_ELEMENTS} elements and ${MAX_SPEC_BYTES / 1024} KiB.

## Ids, refs and asks
- "id": a name for an element (1 to 64 letters, digits, ".", "_", "-"), used once in its document: one chat message, one Change Guide, one goal. A BlockRef { "id" } or a Sequence frame { "ref": "<id>" } draws that element again, with its own state, so you never copy a block to show it twice. A ref to another document's element is "<document>#<id>".
- "ask": { "required": true | false, "prompt"?: "<one line>" } says the element asks the person something. A required ask is an open question: it needs an "id", shows in the workspace's questions and "Needs you", and the person answers through the block's own choice (an AskCard option, or a button that stages); the answer arrives as your next message. An optional ask is only an invitation and creates no question. Ask only on blocks in your chat messages.

## Sequences
A Sequence plays like a short video: frame 1 shows as a still with a play button, and play reads each frame's \`say\` aloud and shows it as the subtitle, then moves on. Write it as you would explain it out loud:
- One point per frame, 2 to 30 frames. A frame's \`content\` is one element (with "children" naming keys in "elements" when it has any) or { "ref": "<id>" } to show a block of this document again. A frame holds no Sequence, and no "id" or "ask".
- \`say\`: one or two plain sentences (at most 400 characters) saying what to look at in the frame, not what the frame already reads. \`caption\` only when the subtitle should differ.
- \`hold\`: seconds for a frame with no voice line or one that needs looking at longer; without a voice a frame lasts 4 s.
- A frame whose content fails the checks shows as an error in its place; fix it like any block.

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
