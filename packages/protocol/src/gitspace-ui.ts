// GitSpace UI blocks: the fenced blocks an agent may write in Markdown (```gitspace-ui, ```svg, ```mermaid), the catalog
// a gitspace-ui spec may use, the validator GitSpace runs before it stores a block, and the agent's instructions.
// A gitspace-ui spec has json-render's shape { root, elements, state }; the catalog is plain zod so the protocol needs no
// json-render dependency.
import { z } from 'zod';
import { CommentIdSchema } from '@gitspace/protocol-runtime/comments';

export interface UiBlockIssue {
  path: string;
  message: string;
}

export type UiBlockKind = 'gitspace-ui' | 'svg' | 'mermaid';

export interface UiBlock {
  kind: UiBlockKind;
  body: string;
  /** The fence's info string after the kind: `<Component> [id=<id>] [ask|ask=required]` for a short-form gitspace-ui
   * fence, '' otherwise. */
  info: string;
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
  /** The drawing's source with its literal colours as theme colours (`themeColour`), as GitSpace stores it. */
  source: string;
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
/** The property that keeps a mapped paint's alpha; `color` and `lighting-color` have none, so their alpha is dropped. */
const PAINT_OPACITY: Readonly<Record<string, string>> = { fill: 'fill-opacity', stroke: 'stroke-opacity', 'stop-color': 'stop-opacity', 'flood-color': 'flood-opacity' };
/** Theme variables a drawing colours with: each is set in both the light and the dark theme (@gitspace/ui fluid-theme.css). */
const SVG_THEME_VARIABLES = ['--foreground', '--muted-foreground', '--background', '--card', '--muted', '--border', '--accent', '--destructive', '--success', '--warning', '--focus-ring', '--chart-1', '--chart-2', '--chart-3', '--surface-2'];

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
/** The languages a CallDiff highlights. */
const CODE_LANGUAGES = ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'ruby', 'sql', 'shell', 'yaml', 'markdown', 'json', 'css', 'html'] as const;
/** Short names agents write for a language (as Markdown fences name them), read as that language. */
const CODE_LANGUAGE_ALIASES: Record<string, (typeof CODE_LANGUAGES)[number]> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', golang: 'go', rs: 'rust',
  kt: 'kotlin', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', md: 'markdown',
};
/** A language by its name or an alias, in any case; the parsed value is the language's name. */
const codeLanguage = z.string().transform((name) => CODE_LANGUAGE_ALIASES[name.toLowerCase()] ?? name.toLowerCase()).pipe(z.enum(CODE_LANGUAGES));

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
    description: 'A small code change drawn as GitSpace draws diffs. Build it with tools.blocks diff from the workspace\'s real diff.',
  },
  CodeExcerpt: {
    props: z.strictObject({
      path: z.string().min(1).max(300).describe('The repository file'),
      startLine: z.number().int().min(1).describe('The line number of the first line'),
      lines: z.array(z.string().max(1000)).min(1).max(120).describe('The file\'s lines from startLine, as they are'),
      commit: z.string().regex(/^[a-f0-9]{7,64}$/u, 'commit is a commit id: 7 to 64 lowercase hex digits').nullish().describe('The commit the lines are from; the current file when omitted'),
      highlight: z.array(z.number().int().min(1)).max(120).nullish().describe('Line numbers (as the file numbers them) to mark'),
      note: z.string().max(400).nullish().describe('One line under the lines: what to look at'),
    }),
    description: 'Lines of one repository file with their line numbers, the ones that matter marked; the path opens the file in the Inspector from the first line. Build it with tools.blocks excerpt rather than copying lines.',
  },
  CommandRun: {
    props: z.strictObject({
      command: z.string().min(1).max(2000),
      exitCode: z.number().int(),
      durationMs: z.number().nonnegative(),
      output: z.string().max(16_000).describe('The end of the output'),
      truncated: z.boolean().describe('Whether output is only the end of a longer output'),
      jobId: z.string().max(200).nullish().describe('The job or process it ran as'),
      cwd: z.string().max(300).nullish(),
    }),
    description: 'A command that ran: a pass or fail badge from its exit code, its duration, and its output folded until opened. Build it with tools.blocks commandRun from the job.',
  },
  TestReport: {
    props: z.strictObject({
      runner: z.string().max(40).nullish().describe('vitest, bun test, jest, pytest, go test…'),
      passed: z.number().int().nonnegative().nullable().describe('null when the output does not say'),
      failed: z.number().int().nonnegative().nullable(),
      skipped: z.number().int().nonnegative().nullable(),
      durationMs: z.number().nonnegative().nullish(),
      failures: z.array(z.strictObject({ name: z.string().min(1).max(300), file: z.string().max(300).nullish(), message: z.string().max(2000) })).max(40),
      flaky: z.array(z.string().min(1).max(300)).max(40).nullish().describe('Tests that failed, then passed on a retry'),
      note: z.string().max(400).nullish(),
    }),
    description: 'A test run: passed, failed and skipped counts, each failure with its file and message, and flaky tests. Build it with tools.blocks testReport from the run\'s job rather than retyping its numbers.',
  },
  ChangeSet: {
    props: z.strictObject({
      base: z.string().max(200).nullish().describe('What the files are compared with: a branch or commit'),
      head: z.string().max(200).nullish(),
      files: z.array(z.strictObject({
        path: z.string().min(1).max(300),
        added: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
        status: z.enum(['added', 'modified', 'deleted', 'renamed', 'conflicted']),
        binary: z.boolean().nullish(),
      })).min(1).max(400),
      groups: z.array(z.strictObject({ name: z.string().min(1).max(120), paths: z.array(z.string().min(1)).min(1) })).max(60).nullish().describe('Areas in order, each naming its files\' paths; files in no group show last'),
    }),
    description: 'The files a change touches, grouped by area, each with its +/- line counts and status; a file opens its diff in the Inspector. Build it with tools.blocks changeSet.',
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
      language: codeLanguage.nullish().describe(`Highlights the code; typescript when omitted. One of ${CODE_LANGUAGES.join(', ')}; short names such as ts, js, py, sh, yml are read as these`),
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
      note: z.string().max(300).nullish().describe('One short line under the comparison: how it was scored, what a score depends on'),
    }),
    description: 'Options scored against criteria as a colored grid, the recommended one marked, and an optional note under it. The person picks an option; it stages as their decision.',
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
    description: 'A narrated walkthrough played like a short video: one frame at a time, each with a voice line (`say`) the person hears and reads as a subtitle. It shows frame 1 as a still with a play button and never plays by itself; the person steps through, changes speed or mutes. A frame lasts its speech and at least its `hold`; without a voice, its `hold` or the time its line takes to read. Each frame shows one thing: Markdown, Svg, Mermaid, CallDiff, StateFlow, Image, Video or any component except a Sequence, or a block of this document by { "ref": "<id>" }. Write 2 to 30 frames, one point each, in the order you would explain it.',
  },
  Reply: {
    props: z.strictObject({
      comment: CommentIdSchema.describe('The id in the comment\'s data ("cm-…")'),
      quote: z.string().min(1).max(140).nullish().describe('A few words of what the comment is on, quoted'),
      text: z.string().min(1).max(4000).describe('Your answer, in Markdown'),
    }),
    description: 'Your answer to one comment the person sent: shown in the chat linked to the comment, and under the comment where it is. One Reply per comment, as the root of its own block.',
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Finds the ```gitspace-ui, ```svg and ```mermaid fences in Markdown; other fences (and anything inside them) are skipped.
 * A gitspace-ui fence may name a component after the kind (the short form, `fenceSpec`). */
export function extractBlocks(markdown: string): UiBlock[] {
  const blocks: UiBlock[] = [];
  let open: { fence: string; indent: number; kind: UiBlockKind | undefined; info: string; start: number; lines: string[] } | undefined;
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
      const [name = '', ...rest] = info.split(/\s+/u);
      const kind = BLOCK_KINDS.find((each) => each === name && (rest.length === 0 || each === 'gitspace-ui'));
      open = { fence: opening[2], indent: opening[1].length, kind, info: rest.join(' '), start: lineStart, lines: [] };
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (closing !== null && closing[1][0] === open.fence[0] && closing[1].length >= open.fence.length) {
      if (open.kind !== undefined) blocks.push({ kind: open.kind, body: open.lines.join('\n'), info: open.info, start: open.start, end: lineStart + rawLine.length, closed: true });
      open = undefined;
      continue;
    }
    if (open.kind !== undefined) open.lines.push(line.replace(new RegExp(`^ {0,${open.indent}}`), ''));
  }
  if (open?.kind !== undefined) blocks.push({ kind: open.kind, body: open.lines.join('\n'), info: open.info, start: open.start, end: markdown.length, closed: false });
  return blocks;
}

/** A short-form fence's info string: the component it draws, the element's id and its ask. */
interface ShortForm { component: string; id: string | null; ask: 'optional' | 'required' | null }

const SHORT_FORM_OPTION = /^(?:id=(\S+)|ask(=required)?)$/u;

/** The short form an info string names; null for the full form (no info), or the issue with it. */
function shortForm(info: string): ShortForm | null | UiBlockIssue {
  const [component, ...options] = info.split(/\s+/u).filter(Boolean);
  if (component === undefined) return null;
  if (!componentByType.has(component)) return { path: '', message: `unknown component "${component}" in the fence's info string; the closest are ${closestNames(component, [...componentByType.keys()]).join(', ')}` };
  const form: ShortForm = { component, id: null, ask: null };
  for (const option of options) {
    const match = SHORT_FORM_OPTION.exec(option);
    if (match === null) return { path: '', message: `unknown option "${option}" in the fence's info string; after the component it takes id=<id>, ask or ask=required` };
    if (match[1] !== undefined) form.id = match[1];
    else form.ask = match[2] === undefined ? 'optional' : 'required';
  }
  return form;
}

/** The `count` names closest to `name` by edit distance, ignoring case. */
function closestNames(name: string, names: readonly string[], count = 3): string[] {
  const target = name.toLowerCase();
  const distance = (other: string): number => {
    const candidate = other.toLowerCase();
    let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
    for (let row = 1; row <= target.length; row++) {
      const current = [row];
      for (let column = 1; column <= candidate.length; column++) {
        current.push(Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + (target[row - 1] === candidate[column - 1] ? 0 : 1)));
      }
      previous = current;
    }
    return previous[candidate.length];
  };
  return names.map((other) => ({ other, score: distance(other) })).sort((a, b) => a.score - b.score).slice(0, count).map(({ other }) => other);
}

/**
 * The spec a gitspace-ui fence holds, or the issue that keeps it from holding one. The full form is the spec's JSON. The
 * short form names one component in the info string (`gitspace-ui CallDiff id=fix ask=required`) and holds only its
 * props; it expands to a one-element spec whose element has that id and ask (`ask` optional, `ask=required` required).
 * A short-form AskCard whose props have no `value` is wired as a question card: `question`, `options` and an optional
 * `prompt` (the question when omitted) and `questionId` (the id, or "ask") are given, and the expansion binds the pick,
 * reads /staged, /sent and /answered and answers the question. A CallDiff's language given by an alias ("ts", "sh") is
 * expanded to the language's name, in either form, so a renderer reads only the names.
 */
export function fenceSpec(body: string, info: string): { spec: unknown } | { issue: UiBlockIssue } {
  const form = shortForm(info);
  if (form !== null && !('component' in form)) return { issue: form };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { issue: { path: '', message: `the gitspace-ui block is not JSON: ${error instanceof Error ? error.message : String(error)}` } };
  }
  canonicalLanguages(form === null ? parsed : { type: form.component, props: parsed });
  if (form === null) return { spec: parsed };
  if (!isRecord(parsed)) return { issue: { path: '', message: `a short-form block holds one JSON object: the props of ${form.component}` } };
  const element: Record<string, unknown> = { type: form.component, props: parsed, children: [] };
  if (form.id !== null) element.id = form.id;
  if (form.ask !== null) element.ask = { required: form.ask === 'required' };
  if (form.component !== 'AskCard' || Object.hasOwn(parsed, 'value')) return { spec: { root: 'block', elements: { block: element }, state: {} } };
  const questionId = typeof parsed.questionId === 'string' ? parsed.questionId : form.id ?? 'ask';
  const label = { $computed: 'lookup', args: { items: { $state: '/options' }, key: 'value', value: { $state: '/answer' }, field: 'label' } };
  element.props = { prompt: parsed.question, ...parsed, questionId, options: { $state: '/options' }, value: { $bindState: '/answer' }, staged: { $state: `/staged/${questionId}` }, sent: { $state: `/sent/${questionId}` }, answered: { $state: '/answered' } };
  element.on = { answer: { action: 'answer_question', params: { questionId, question: parsed.question, answer: { $state: '/answer' }, label } } };
  return { spec: { root: 'block', elements: { block: element }, state: { answer: '', options: parsed.options } } };
}

/** Writes a CallDiff's language alias or differently cased name as the language's name, wherever the element is: in
 * "elements", in a Sequence frame or in a short form's props. */
function canonicalLanguages(value: unknown): void {
  if (Array.isArray(value)) value.forEach(canonicalLanguages);
  if (!isRecord(value)) return;
  if (value.type === 'CallDiff' && isRecord(value.props) && typeof value.props.language === 'string') {
    const read = codeLanguage.safeParse(value.props.language);
    if (read.success) value.props.language = read.data;
  }
  Object.values(value).forEach(canonicalLanguages);
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
  const read = fenceSpec(block.body, block.info);
  return 'issue' in read ? { issues: [read.issue], ids: new Map(), refs: [] } : checkSpec(read.spec);
}

function validateBlock(block: UiBlock): UiBlockIssue[] {
  if (!block.closed) return [{ path: '', message: `the \`\`\`${block.kind} fence is not closed` }];
  if (block.kind === 'svg') return validateSvg(block.body);
  if (block.kind === 'mermaid') return validateMermaid(block.body);
  return checkBlock(block).issues;
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
    const read = fenceSpec(block.body, block.info);
    if ('issue' in read) continue;
    const { spec } = read;
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

/** A Reply element's answer: the comment it names and its text (null when the text is an expression). */
export interface BlockReply { comment: string; text: string | null }

/** The Reply elements of the gitspace-ui blocks in Markdown, in order; a block that fails the checks answers nothing. */
export function blockReplies(markdown: string): BlockReply[] {
  const replies: BlockReply[] = [];
  for (const block of extractBlocks(markdown)) {
    if (block.kind !== 'gitspace-ui' || !block.closed) continue;
    const read = fenceSpec(block.body, block.info);
    if ('issue' in read) continue;
    const { spec } = read;
    if (!isRecord(spec) || !isRecord(spec.elements) || checkSpec(spec).issues.length > 0) continue;
    for (const element of Object.values(spec.elements)) {
      if (!isRecord(element) || element.type !== 'Reply' || !isRecord(element.props) || typeof element.props.comment !== 'string') continue;
      replies.push({ comment: element.props.comment, text: typeof element.props.text === 'string' ? element.props.text : null });
    }
  }
  return replies;
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
    } else if (type === 'ChangeSet' && !hasExpression(element.props)) {
      const set = components.ChangeSet.props.safeParse(element.props);
      if (set.success) {
        const files = new Set(set.data.files.map(file => file.path));
        set.data.groups?.forEach((group, index) => group.paths.forEach((file, position) => {
          if (!files.has(file)) check.issues.push({ path: [index, 'paths', position].reduce<string>(pointer, pointer(propsPath, 'groups')), message: `no file "${file}" in files` });
        }));
      }
    } else if (type === 'CodeExcerpt' && !hasExpression(element.props)) {
      const excerpt = components.CodeExcerpt.props.safeParse(element.props);
      if (excerpt.success) {
        const last = excerpt.data.startLine + excerpt.data.lines.length - 1;
        excerpt.data.highlight?.forEach((line, index) => {
          if (line < excerpt.data.startLine || line > last) check.issues.push({ path: pointer(pointer(propsPath, 'highlight'), index), message: `line ${line} is not among the excerpt's lines ${excerpt.data.startLine}–${last}` });
        });
      }
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

/** The value at a state path (a JSON pointer), or undefined when the state has none. */
export function readState(state: unknown, statePath: string): unknown {
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
  if (bytes > MAX_SVG_BYTES) return { root: null, issues: [{ path: '', message: `the SVG is ${bytes} bytes; the limit is ${MAX_SVG_BYTES}` }], source: svg };
  const issues: UiBlockIssue[] = [];
  const stack: { node: SvgElementNode; path: string; children: number }[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const declaration = /<\?xml(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*\?>/y;
  let root: SvgElementNode | null = null;
  let roots = 0;
  let index = 0;
  // The source with each tag's mapped attributes, copied up to `copied`.
  let source = '';
  let copied = 0;
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
    const checked = checkSvgAttributes(attributes, path, issues);
    if (checked.source !== attributes) {
      const at = next + 1 + name.length;
      source += svg.slice(copied, at) + checked.source;
      copied = at + attributes.length;
    }
    const node: SvgElementNode = { name, attributes: checked.decoded, children: [] };
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
  return { root, issues, source: source + svg.slice(copied) };
}

const LOCAL_REFERENCE = /^#[\w.:-]+$/;
const ENTITY = /&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function decodeEntity(entity: string, hex: string | undefined, decimal: string | undefined, named: string | undefined): string {
  const code = hex !== undefined ? Number.parseInt(hex, 16) : decimal !== undefined ? Number(decimal) : undefined;
  if (code === undefined) return NAMED_ENTITIES[named ?? ''] ?? entity;
  return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
}

/** One attribute of a tag: its source, its raw and given (decoded) values, and the value it is stored with; null values
 * for one refused for a bare "&". */
interface SvgAttribute { segment: string; raw: string; name: string; given: string | null; value: string | null }

/**
 * Checks a tag's attributes. Returns them decoded, with literal colours as theme colours (`themeColour`) and a mapped
 * paint's alpha in its opacity attribute (multiplying one the tag sets), and the attributes' source with the same values.
 */
function checkSvgAttributes(attributes: string, path: string, issues: UiBlockIssue[]): { decoded: [string, string][]; source: string } {
  const read: SvgAttribute[] = [];
  const opacities = new Map<string, number>();
  for (const [segment, name, doubleQuoted, singleQuoted] of attributes.matchAll(/\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const raw = doubleQuoted ?? singleQuoted ?? '';
    if (raw.replace(ENTITY, '').includes('&')) {
      issues.push({ path, message: `${name}: "&" must start an entity such as &amp;` });
      read.push({ segment, raw, name, given: null, value: null });
      continue;
    }
    const given = raw.replace(ENTITY, decodeEntity);
    const lower = name.toLowerCase();
    let value = given;
    if (lower === 'style') value = themeStyle(given);
    else if (SVG_PAINT_PROPERTIES.has(lower)) {
      const colour = themeColour(given);
      const opacity = PAINT_OPACITY[lower];
      if (colour !== null) value = colour.paint;
      if (colour !== null && opacity !== undefined && colour.opacity < 1) opacities.set(opacity, colour.opacity);
    }
    read.push({ segment, raw, name, given, value });
    if (lower.startsWith('on')) issues.push({ path, message: `${name}: event handler attributes are not allowed` });
    else if (lower === 'href' || lower.endsWith(':href')) {
      if (!LOCAL_REFERENCE.test(value.trim())) issues.push({ path, message: `${name}="${value}": only a local "#id" reference is allowed` });
    } else if (lower === 'style') checkSvgStyle(value, path, issues);
    else if (SVG_PAINT_PROPERTIES.has(lower)) checkSvgPaint(lower, value, path, issues);
    if (!lower.startsWith('xmlns')) checkSvgUrls(name, value, path, issues);
  }
  for (const [name, opacity] of opacities) {
    const set = read.find(attribute => attribute.name.toLowerCase() === name && attribute.value !== null);
    const current = set === undefined ? null : opacityValue(set.value ?? '');
    if (set === undefined) read.push({ segment: ` ${name}="${opacity}"`, raw: String(opacity), name, given: String(opacity), value: String(opacity) });
    else if (current !== null) set.value = String(Math.round(current * opacity * 1000) / 1000);
  }
  return {
    decoded: read.flatMap(attribute => attribute.value === null ? [] : [[attribute.name, attribute.value]]),
    source: read.map(({ segment, raw, given, value }) => value === null || value === given ? segment : `${segment.slice(0, segment.length - raw.length - 1)}${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('\'', '&apos;')}${segment.at(-1) ?? ''}`).join(''),
  };
}

/** An opacity value (`0.5` or `50%`) as a number; null for anything else. */
function opacityValue(text: string): number | null {
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%?)\s*$/.exec(text);
  return match === null ? null : Number(match[1]) / (match[2] === '%' ? 100 : 1);
}

/** A style attribute with the literal colours of its paint declarations as theme colours, a mapped paint's alpha in
 * its opacity declaration (multiplying one the style sets, else added). */
function themeStyle(style: string): string {
  const opacities = new Map<string, number>();
  const declarations = style.split(';').map(declaration => {
    const colon = declaration.indexOf(':');
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (colon === -1 || !SVG_PAINT_PROPERTIES.has(property)) return declaration;
    const value = declaration.slice(colon + 1);
    const important = /\s*!important\s*$/i.exec(value)?.[0] ?? '';
    const colour = themeColour(value.slice(0, value.length - important.length));
    if (colour === null) return declaration;
    const opacity = PAINT_OPACITY[property];
    if (opacity !== undefined && colour.opacity < 1) opacities.set(opacity, colour.opacity);
    return `${declaration.slice(0, colon + 1)}${colour.paint}${important}`;
  });
  for (const [name, opacity] of opacities) {
    const at = declarations.findIndex(declaration => declaration.slice(0, Math.max(0, declaration.indexOf(':'))).trim().toLowerCase() === name);
    const set = declarations[at];
    const current = set === undefined ? null : opacityValue(set.slice(set.indexOf(':') + 1));
    if (set === undefined) declarations.push(`${name}:${opacity}`);
    else if (current !== null) declarations[at] = `${set.slice(0, set.indexOf(':') + 1)}${Math.round(current * opacity * 1000) / 1000}`;
  }
  return declarations.join(';');
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
  issues.push({ path, message: `${property}="${paint}": colours are currentColor, none, a theme variable such as var(--foreground) or a literal colour (hex, rgb(), hsl() or a CSS name)${property === 'fill' || property === 'stroke' ? ', or url(#id)' : ''}` });
}

/** CSS named colours as six hex digits. */
const NAMED_COLOURS: Readonly<Record<string, string>> = Object.fromEntries('aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32'.split(' ').map((pair): [string, string] => [pair.slice(0, -7), pair.slice(-6)]));
/** Below this chroma (the channels' spread, 0 to 1) a colour is a neutral grey; slate greys stay under it. */
const SATURATED_CHROMA = 0.16;
/** A colour this light with at least `TINT_CHROMA` is a pale tint of its hue rather than a grey. */
const TINT_LIGHTNESS = 0.8;
const TINT_CHROMA = 0.1;
/** Neutrals by HSL lightness, lightest first: each band's theme colour holds about that lightness in the light theme. */
const NEUTRAL_BANDS: readonly { from: number; paint: string }[] = [
  { from: 0.99, paint: 'var(--card)' },
  { from: 0.965, paint: 'var(--background)' },
  { from: 0.93, paint: 'var(--muted)' },
  { from: 0.75, paint: 'var(--border)' },
  { from: 0.3, paint: 'var(--muted-foreground)' },
];
/** Saturated colours by hue in degrees, each band below `below`; from 345 on, red again. */
const HUE_BANDS: readonly { below: number; paint: string }[] = [
  { below: 15, paint: 'var(--destructive)' },
  { below: 70, paint: 'var(--warning)' },
  { below: 165, paint: 'var(--success)' },
  { below: 200, paint: 'var(--chart-1)' },
  { below: 250, paint: 'var(--focus-ring)' },
  { below: 290, paint: 'var(--chart-2)' },
  { below: 345, paint: 'var(--chart-3)' },
];

/** A CSS number or percentage as a fraction of `whole` (a percentage of 100), clamped to 0 to 1; null for anything else. */
function colourAmount(token: string | undefined, whole: number): number | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%?)$/.exec(token ?? '');
  return match === null ? null : Math.min(1, Math.max(0, Number(match[1]) / (match[2] === '%' ? 100 : whole)));
}

/** A hex, rgb(), rgba(), hsl(), hsla() or named colour as channels from 0 to 1; null for anything else. */
function literalColour(value: string): { red: number; green: number; blue: number; alpha: number } | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1] ?? NAMED_COLOURS[text];
  if (hex !== undefined) {
    const digits = hex.length <= 4 ? [...hex].map(digit => digit + digit).join('') : hex;
    const [red, green, blue, alpha = 255] = [0, 2, 4, 6].flatMap(at => at < digits.length ? [Number.parseInt(digits.slice(at, at + 2), 16)] : []);
    return red === undefined || green === undefined || blue === undefined ? null : { red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha / 255 };
  }
  const call = /^(rgba?|hsla?)\(\s*([^()]*?)\s*\)$/.exec(text);
  const tokens = call?.[2]?.split(/\s*[,/]\s*|\s+/) ?? [];
  if (call === null || (tokens.length !== 3 && tokens.length !== 4)) return null;
  const alpha = tokens.length === 4 ? colourAmount(tokens[3], 1) : 1;
  if (alpha === null) return null;
  if (call[1]?.startsWith('rgb')) {
    const [red, green, blue] = tokens.slice(0, 3).map(token => colourAmount(token, 255));
    return red == null || green == null || blue == null ? null : { red, green, blue, alpha };
  }
  const turn = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(deg|turn|rad|grad)?$/.exec(tokens[0] ?? '');
  const saturation = colourAmount(tokens[1], 100);
  const lightness = colourAmount(tokens[2], 100);
  if (turn === null || saturation === null || lightness === null) return null;
  const degrees = Number(turn[1]) * (turn[2] === 'turn' ? 360 : turn[2] === 'rad' ? 180 / Math.PI : turn[2] === 'grad' ? 0.9 : 1);
  const hue = ((degrees % 360) + 360) % 360;
  const reach = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    return lightness - reach * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { red: channel(0), green: channel(8), blue: channel(4), alpha };
}

/**
 * A literal colour (hex of 3, 4, 6 or 8 digits, rgb(), rgba(), hsl(), hsla() or a CSS name) as the nearest theme colour
 * and the opacity it keeps (1 when opaque); `transparent` is `none`; null for anything else (currentColor, a variable).
 * Neutrals map by lightness (`NEUTRAL_BANDS`), saturated colours by hue (`HUE_BANDS`); a pale tint is its hue's colour
 * with the white it holds as transparency.
 */
export function themeColour(value: string): { paint: string; opacity: number } | null {
  if (value.trim().toLowerCase() === 'transparent') return { paint: 'none', opacity: 1 };
  const colour = literalColour(value);
  if (colour === null) return null;
  const { red, green, blue } = colour;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  const tint = lightness >= TINT_LIGHTNESS && chroma >= TINT_CHROMA;
  if (chroma < SATURATED_CHROMA && !tint) {
    return { paint: NEUTRAL_BANDS.find(band => lightness >= band.from)?.paint ?? 'var(--foreground)', opacity: Math.round(colour.alpha * 100) / 100 };
  }
  const sector = max === red ? ((green - blue) / chroma + 6) % 6 : max === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  const paint = HUE_BANDS.find(band => sector * 60 < band.below)?.paint ?? 'var(--destructive)';
  return { paint, opacity: Math.round(colour.alpha * (tint ? 1 - min : 1) * 100) / 100 };
}

/**
 * Markdown with the literal colours of its blocks' drawings as theme colours (`themeColour`): ```svg fences, and the svg
 * of Svg elements in ```gitspace-ui fences (whose spec is then written back as compact JSON). Everything else, and a
 * fence with nothing to map or that is not closed, is unchanged. GitSpace stores blocks this way.
 */
export function mapBlockColours(markdown: string): string {
  let mapped = '';
  let copied = 0;
  for (const block of extractBlocks(markdown)) {
    if (!block.closed || block.kind === 'mermaid') continue;
    const body = block.kind === 'svg' ? parseSvg(block.body).source : themeSpec(block.body, block.info);
    if (body === block.body) continue;
    const fence = markdown.slice(block.start, block.end);
    const indent = /^ */.exec(fence)?.[0] ?? '';
    mapped += `${markdown.slice(copied, block.start)}${fence.slice(0, fence.indexOf('\n') + 1)}${body.split('\n').map(line => indent + line).join('\n')}\n${fence.slice(fence.lastIndexOf('\n') + 1)}`;
    copied = block.end;
  }
  return mapped + markdown.slice(copied);
}

/** A gitspace-ui fence's JSON with the literal colours of its Svg elements' svg as theme colours; unchanged when it is
 * not JSON or has none to map. A short-form fence keeps its short form. */
function themeSpec(body: string, info: string): string {
  const form = shortForm(info);
  if (form !== null && !('component' in form)) return body;
  let spec: unknown;
  try {
    spec = JSON.parse(body);
  } catch {
    return body;
  }
  let changed = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    if (!isRecord(value)) return;
    if (value.type === 'Svg' && isRecord(value.props) && typeof value.props.svg === 'string') {
      const source = parseSvg(value.props.svg).source;
      changed ||= source !== value.props.svg;
      value.props.svg = source;
    }
    Object.values(value).forEach(visit);
  };
  visit(form === null ? spec : { type: form.component, props: spec });
  return changed ? JSON.stringify(spec) : body;
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

/** A worked example in the `gitspace-ui` skill: when to draw it, its fence's info string and the block itself. Every
 * example passes `validateMarkdownBlocks` (tested), so the skill never teaches a block GitSpace would reject. */
export interface UiBlockExample { title: string; when: string; fence: string; body: string }

const spec = (value: Record<string, unknown>): string => JSON.stringify(value);

export const UI_BLOCK_EXAMPLES: readonly UiBlockExample[] = [
  {
    title: 'Values over time',
    when: 'A measure that changes over time or over a sequence (memory per turn, latency per release): a line Chart, one line per series.',
    fence: 'gitspace-ui Chart',
    body: spec({
      title: 'Memory per turn (the workspace object resets at 128 MB)', kind: 'line', unit: 'bytes', max: 134217728,
      series: [{ key: 'read', label: 'Read per turn', color: 'blue' }, { key: 'held', label: 'Held after the turn', color: 'violet' }],
      rows: [{ label: 'turn 1', values: { read: 31457280, held: 8388608 } }, { label: 'turn 2', values: { read: 32505856, held: 9437184 } }, { label: 'migrated', values: { read: 11534336, held: 4194304 } }, { label: 'turn 4', values: { read: 11665408, held: 4194304 } }],
    }),
  },
  {
    title: 'How it flows',
    when: 'How a request travels, what a change rewires, an architecture: a FlowMap, as the Change Guide draws a change. Areas grouped by package; paths added, removed or kept; steps that walk the flow.',
    fence: 'gitspace-ui FlowMap id=codemode-output',
    body: spec({
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
    fence: 'gitspace-ui BeforeAfter',
    body: spec({ before: { label: 'Before', title: 'A message from you', body: 'The board arrived as **your** chat bubble.' }, after: { label: 'After', title: 'A notice', body: 'A quiet *Workspace board* row; **Show all** opens the full board.' }, slider: false }),
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
];

const FENCE = '```';

/** One short-form fence: `info` names the component and its options, `props` are its body. */
const shortBlock = (info: string, props: Record<string, unknown>): string => `${FENCE}gitspace-ui ${info}\n${JSON.stringify(props)}\n${FENCE}`;

/** A whole chat reply for one common situation in the `gitspace-ui` skill: a sentence or two, the blocks in the short
 * form, then what they mean or what comes next. Every reply passes `validateMarkdownBlocks` (tested). They follow one
 * fictional app, Shelf, a neighbourhood library's book-lending service, through one change: overdue reminders. */
export interface UiReplyExample { title: string; situation: string; reply: string }

export const UI_REPLY_EXAMPLES: readonly UiReplyExample[] = [
  {
    title: 'A fix explained',
    situation: 'The code path before and after as a CallDiff, then one sentence per change.',
    reply: [
      'Borrowers got the same overdue email twice on nights the reminder job retried: the retry ran the whole loop again, and nothing recorded which emails had gone out. Now each loan is claimed before its email is sent.',
      shortBlock('CallDiff', {
        title: 'sendReminders, before and after',
        lines: [
          { depth: 0, code: 'sendReminders(night)', change: 'same', path: 'apps/api/src/reminders.ts' },
          { depth: 1, code: 'const overdue = await loans.overdue(night)', change: 'same' },
          { depth: 1, code: 'for (const loan of overdue)', change: 'same' },
          { depth: 2, code: 'await mail.send(loan.borrower, overdueEmail(loan))', change: 'removed', note: 'sent again on every retry' },
          { depth: 2, code: 'if (!(await loans.claimReminder(loan.id))) continue', change: 'added', note: 'one run wins each loan', path: 'apps/api/src/loans.ts' },
          { depth: 2, code: 'await mail.send(loan.borrower, overdueEmail(loan))', change: 'added', note: 'only for a loan this run claimed' },
        ],
      }),
      '- `loans.claimReminder` sets `reminded_at` only where it is still empty and says whether this run set it, so exactly one run claims each loan.\n- `mail.send` runs only after a claim succeeds, so a retry skips every email already sent.',
      'A new test runs the job twice over the same night and expects one email per loan; it fails without the claim and passes with it.',
    ].join('\n\n'),
  },
  {
    title: 'Results reported',
    situation: 'Measured numbers as MetricDelta (or Stats for headline numbers alone), and the test run as the TestReport `tools.blocks({ op: "testReport", jobId })` returns.',
    reply: [
      'I replayed last Tuesday\'s 206 overdue loans on staging, before and after the fix:',
      shortBlock('MetricDelta', {
        metrics: [
          { label: 'Emails sent', before: 412, after: 206, unit: 'count', better: 'lower' },
          { label: 'Borrowers emailed twice', before: 198, after: 0, unit: 'count', better: 'lower' },
          { label: 'Run time', before: 47800, after: 49100, unit: 'ms', better: 'lower' },
        ],
      }),
      'Every overdue loan got exactly one email. The run is 1.3 s slower, from one extra write per loan; it still finishes well inside its 30-minute window. The suite passes:',
      shortBlock('TestReport', { runner: 'bun test', passed: 118, failed: 0, skipped: 2, durationMs: 2410, failures: [], flaky: null, note: null }),
      'The 2 skipped tests are for SMS reminders, off until we choose how reminders are sent.',
    ].join('\n\n'),
  },
  {
    title: 'Options compared, then the person decides',
    situation: 'The options scored as Tradeoffs with your recommendation, then the question as an AskCard with id=… ask=required. The AskCard ends the reply: nothing waits, and their pick comes with their next message.',
    reply: [
      'Reminders work; what is left is how they reach borrowers. I recommend one daily digest per borrower: the fewest messages, and it still names every overdue book.',
      shortBlock('Tradeoffs', {
        question: 'How should borrowers hear about overdue books?',
        options: [{ id: 'digest', label: 'Daily digest email' }, { id: 'per-loan', label: 'One email per book' }, { id: 'sms', label: 'SMS' }],
        criteria: [
          { label: 'Few messages', scores: [3, 1, 2] },
          { label: 'Clear which book is late', scores: [2, 3, 2] },
          { label: 'Running cost', scores: [3, 3, 1], note: 'SMS is about $40 a month at today\'s volume' },
          { label: 'Time to build', scores: [2, 3, 0], note: 'SMS needs phone numbers, which Shelf does not collect' },
        ],
        recommended: 'digest',
        note: 'Scores are my judgement at today\'s volume of about 200 overdue loans a night.',
      }),
      'SMS reaches people fastest, but it needs a new sign-up field before it can send anything. Which should I build?',
      shortBlock('AskCard id=reminder-channel ask=required', {
        question: 'How should borrowers hear about overdue books?',
        options: [
          { value: 'digest', label: 'Daily digest email', description: 'One email per borrower listing every overdue book' },
          { value: 'per-loan', label: 'One email per book' },
          { value: 'sms', label: 'SMS', description: 'About $40 a month; collect phone numbers first' },
        ],
      }),
    ].join('\n\n'),
  },
  {
    title: 'A failed deploy or an incident',
    situation: 'What happened, and when, as a Timeline; the command that failed as the CommandRun `tools.blocks({ op: "commandRun", jobId })` returns; then what you changed so it cannot recur.',
    reply: [
      'Last night\'s v1.8 deploy failed, and for about 30 seconds 31% of API requests failed with it. v1.7 is still live, the migration applied nothing, and no data was lost.',
      shortBlock('Timeline', {
        title: 'v1.8 deploy, 12 November (UTC)',
        events: [
          { at: '2026-11-12T02:00:04Z', kind: 'deploy', label: 'v1.8 deploy starts' },
          { at: '2026-11-12T02:00:11Z', kind: 'note', label: 'Migration 0014 waits for its lock', detail: 'The nightly reminder run held a long transaction on loans.' },
          { at: '2026-11-12T02:00:13Z', kind: 'error', label: 'Loan requests queue behind the migration', detail: 'Every read of loans waited for the same lock; 31% of requests timed out.' },
          { at: '2026-11-12T02:00:41Z', kind: 'alert', label: 'Migration hits its 30 s lock timeout' },
          { at: '2026-11-12T02:00:42Z', kind: 'fix', label: 'Deploy aborted; v1.7 serves normally', detail: 'Errors back to 0 by 02:00:50.' },
        ],
      }),
      'The deploy started during the nightly reminder run. Its migration waited for a lock on loans, and every loan request queued behind it until the migration gave up:',
      shortBlock('CommandRun', {
        command: 'bun run deploy --env production', exitCode: 1, durationMs: 38012,
        output: 'Building api… done in 6.1s\nRunning migrations\nApplying 0014_loan_reminders.sql\nALTER TABLE loans ADD COLUMN reminded_at timestamptz;\nerror: canceling statement due to lock timeout\n  at migrate (apps/api/scripts/migrate.ts:38:11)\nMigration 0014 failed; nothing was applied.\nDeploy aborted: v1.7 stays live.',
        truncated: false, jobId: 'job:7', cwd: 'apps/api',
      }),
      'Two changes so it cannot happen again: deploys now wait for the reminder run to finish, and migrations set a 5 s lock timeout, so a blocked migration gives up before requests pile up. I will deploy v1.8 again at 09:00 UTC unless you want another time.',
    ].join('\n\n'),
  },
  {
    title: 'A schema change',
    situation: 'The tables a migration touches as a SchemaDiff, then what it costs to run and to roll back.',
    reply: [
      'Migration 0014 adds what the reminder claim needs: one empty column on loans, an index for the nightly query, and a log of every reminder sent.',
      shortBlock('SchemaDiff', {
        title: 'Migration 0014: loan reminders',
        tables: [
          {
            name: 'loans', change: 'changed', rows: '84k rows', cost: 'lock',
            columns: [
              { name: 'id', type: 'uuid', change: 'same', key: 'primary' },
              { name: 'due_on', type: 'date', change: 'same' },
              { name: 'returned_at', type: 'timestamptz', change: 'same', nullable: true },
              { name: 'reminded_at', type: 'timestamptz', change: 'added', nullable: true, note: 'set by the claim; empty until a reminder goes out' },
            ],
            indexes: [{ name: 'loans_overdue_idx', columns: ['due_on'], change: 'added' }],
          },
          {
            name: 'reminders', change: 'added', cost: 'none',
            columns: [
              { name: 'id', type: 'uuid', change: 'added', key: 'primary' },
              { name: 'loan_id', type: 'uuid', change: 'added', references: 'loans.id' },
              { name: 'sent_at', type: 'timestamptz', change: 'added' },
              { name: 'channel', type: 'text', change: 'added', note: '"email" for now' },
            ],
          },
        ],
      }),
      'A nullable column without a default is added without rewriting the table, and the index is built concurrently, so loans is locked only for a moment. Rolling back drops the column, the index and the table; nothing else reads them yet.',
    ].join('\n\n'),
  },
  {
    title: 'A change walkthrough',
    situation: 'The blocks the change needs, each with an id, then a Sequence that plays them in order: a frame shows an earlier block again by { "ref": "<its id>" } rather than copying it.',
    reply: [
      'Here is the reminders change: the code path, what it did to last Tuesday\'s run, and a short narrated walkthrough of both.',
      shortBlock('CallDiff id=claim-path', {
        lines: [
          { depth: 0, code: 'for (const loan of overdue)', change: 'same', path: 'apps/api/src/reminders.ts' },
          { depth: 1, code: 'await mail.send(loan.borrower, overdueEmail(loan))', change: 'removed', note: 'sent again on every retry' },
          { depth: 1, code: 'if (!(await loans.claimReminder(loan.id))) continue', change: 'added', note: 'one run wins each loan' },
          { depth: 1, code: 'await mail.send(loan.borrower, overdueEmail(loan))', change: 'added' },
        ],
      }),
      shortBlock('Stats id=reminder-numbers', {
        tiles: [{ label: 'Emails per night', value: 206, detail: 'was 412', tone: 'good' }, { label: 'Borrowers emailed twice', value: 0, detail: 'was 198', tone: 'good' }],
      }),
      shortBlock('Sequence', {
        title: 'One overdue email per loan',
        frames: [
          { content: { type: 'Markdown', props: { content: '**One overdue email per loan**, even when the nightly run retries.' }, children: [] }, say: 'This change stops borrowers getting the same overdue email twice.' },
          { content: { ref: 'claim-path' }, say: 'Each loan is claimed before its email goes out. A retry finds the loan claimed and skips it.' },
          { content: { type: 'Markdown', props: { content: '`claimReminder` sets `reminded_at` only where it is still empty: one update, so two runs never both win.' }, children: [] }, say: 'The claim is a single update on a new column, so two runs can never claim the same loan.' },
          { content: { ref: 'reminder-numbers' }, say: 'On last Tuesday\'s loans, emails halved and nobody got two.', hold: 5 },
        ],
      }),
      'Play it for the narrated version, or read the two blocks above it. Next is the migration that adds `reminded_at`.',
    ].join('\n\n'),
  },
  {
    title: 'Answering the person\'s comments',
    situation: 'Their message holds Comment on “…” lines, each with its { "comment": { "id" } }. One Reply block per comment, then go on with the work.',
    reply: [
      'Both answered below; the second one found a gap, which I have fixed.',
      shortBlock('Reply', { comment: 'cm-4f1a9c2e7b30', quote: 'Run time', text: 'Yes. The run has a 30-minute window and takes under a minute; the extra 1.3 s is one update per loan.' }),
      shortBlock('Reply', { comment: 'cm-9d03b6e1a57c', quote: 'one extra write per loan', text: 'Then the loan stayed claimed and that borrower got no email that night. Now a failed send clears `reminded_at`, so the next run tries again.' }),
      'The fix is in `reminders.ts`, with a test where the mail service fails; the suite passes. Next is the digest email.',
    ].join('\n\n'),
  },
  {
    title: 'Finished work summarised',
    situation: 'What changed as the ChangeSet `tools.blocks({ op: "changeSet" })` returns and the final test run as a TestReport, then anything the person should check before it ships.',
    reply: [
      'Overdue reminders are done on `overdue-reminders`: each loan is claimed before its email goes out, so a retry never sends twice, and borrowers get one daily digest.',
      shortBlock('ChangeSet', {
        base: 'main', head: 'overdue-reminders',
        files: [
          { path: 'apps/api/migrations/0014_loan_reminders.sql', added: 9, removed: 0, status: 'added' },
          { path: 'apps/api/src/digest-email.ts', added: 38, removed: 0, status: 'added' },
          { path: 'apps/api/src/loans.ts', added: 12, removed: 2, status: 'modified' },
          { path: 'apps/api/src/reminders.ts', added: 41, removed: 18, status: 'modified' },
          { path: 'apps/api/test/reminders.test.ts', added: 71, removed: 0, status: 'added' },
          { path: 'apps/web/src/LoanCard.tsx', added: 7, removed: 3, status: 'modified' },
        ],
        groups: [
          { name: 'apps/api', paths: ['apps/api/migrations/0014_loan_reminders.sql', 'apps/api/src/digest-email.ts', 'apps/api/src/loans.ts', 'apps/api/src/reminders.ts', 'apps/api/test/reminders.test.ts'] },
          { name: 'apps/web', paths: ['apps/web/src/LoanCard.tsx'] },
        ],
      }),
      shortBlock('TestReport', { runner: 'bun test', passed: 124, failed: 0, skipped: 0, durationMs: 2630, failures: [], flaky: null, note: null }),
      'The only change people see is on a loan\'s card in the app: when its last reminder went out. It is ready to merge; deploy after 02:30 UTC, when the reminder run has finished.',
    ].join('\n\n'),
  },
];

/** The props the drawing brief shows for its most used components: each is a valid short-form block (tested), with the
 * fields it leaves out. */
const BRIEF_SHAPES: readonly { component: string; options?: string; props: Record<string, unknown>; also?: string }[] = [
  { component: 'CallDiff', options: 'id=cache-path', props: { lines: [{ depth: 0, code: 'reply(req)', change: 'same' }, { depth: 1, code: 'kv.get(key)', change: 'removed' }, { depth: 1, code: 'cache.get(key)', change: 'added', note: 'strong reads' }] }, also: 'title, language; line path' },
  { component: 'StateFlow', props: { services: [{ id: 'w', name: 'Worker' }, { id: 'c', name: 'Cache', change: 'added', state: [{ key: 'hits', value: '0' }] }], steps: [{ from: 'w', to: 'c', label: 'get(key)', caption: 'Reads go to the cache.', sets: [{ service: 'c', key: 'hits', value: '1' }] }] }, also: 'title; service role, parent' },
  { component: 'Table', props: { columns: [{ key: 'store', label: 'Store' }, { key: 'read', label: 'Read', align: 'right' }], rows: [{ store: 'KV', read: '4 ms' }] }, also: 'caption; column mono' },
  { component: 'Stats', props: { tiles: [{ label: 'p50', value: '1.8 s', detail: 'was 3.1 s', tone: 'good' }] }, also: 'tone neutral|good|bad' },
  { component: 'MetricDelta', props: { metrics: [{ label: 'p95', before: 4400, after: 2600, unit: 'ms', better: 'lower' }] }, also: 'trend; unit ms|seconds|count|percent|bytes|usd|tokens' },
  { component: 'Chart', props: { kind: 'line', unit: 'ms', series: [{ key: 'p50', label: 'p50', color: 'blue' }], rows: [{ label: 'v1', values: { p50: 3100 } }, { label: 'v2', values: { p50: 1800 } }] }, also: 'title, max; kind bars|columns|line|stacked' },
  { component: 'Tradeoffs', props: { question: 'Where do replies live?', options: [{ id: 'kv', label: 'KV' }, { id: 'do', label: 'Durable Object' }], criteria: [{ label: 'Consistency', scores: [1, 3] }], recommended: 'do', note: 'Scores 0–3.' }, also: 'criterion note' },
  { component: 'AskCard', options: 'id=cache ask=required', props: { question: 'Which cache keeps replies?', options: [{ value: 'kv', label: 'Workers KV' }, { value: 'do', label: 'Durable Object' }] }, also: 'prompt (Markdown); option description' },
  { component: 'Timeline', props: { events: [{ at: '2026-11-16T09:12:00Z', kind: 'deploy', label: 'v41 live' }, { at: '2026-11-16T09:20:00Z', kind: 'error', label: '5xx spike' }] }, also: 'title, detail; kind deploy|error|alert|fix|note' },
  { component: 'Sequence', props: { title: 'Fix', frames: [{ content: { type: 'Markdown', props: { content: '**Cached**.' }, children: [] }, say: 'Replies are cached now.' }, { content: { ref: 'cache-path' }, say: 'Reads hit it first.' }] }, also: 'caption, hold' },
  { component: 'Reply', props: { comment: 'cm-0123456789ab', quote: 'the p95 tile', text: 'p95 of 20 runs.' } },
  { component: 'Svg', props: { svg: '<svg viewBox="0 0 80 30"><text x="8" y="20" fill="currentColor">cache</text></svg>' }, also: 'or a ```svg fence' },
];

/** Every agent's instruction about blocks, main agents and subagents alike: when to draw, the short form and the props
 * of the most used components. The `gitspace-ui` skill is the reference for the rest. */
export const UI_BLOCK_BRIEF = [
  'Blocks: GitSpace draws blocks you write in Markdown, in chat and every Markdown field (goal, journal, Change Guide, plan step). Draw when a picture says it better than prose: a sentence first, then the block; one idea per block. Draw even when the person will paste the result elsewhere: every block has Copy as Markdown.',
  `When to draw:
- a fix: CallDiff (code path before and after), StateFlow (state between services)
- numbers: Stats (headlines), MetricDelta (before → after), Chart (kind "line" over time)
- options: Tradeoffs; a schema change: SchemaDiff; events: Timeline; a walkthrough: Sequence
- a diagram: Mermaid (a few boxes) or Svg (theme colours only: currentColor, var(--border)…)
- answering comments: Reply
Prefer the specific block to a Table: before/after numbers → MetricDelta, schema changes → SchemaDiff, events in time → Timeline, options → Tradeoffs.
AskCard ask=required only when they'll decide ("let me pick") or you're blocked on their pick: compare, recommend one, end with it (example reply "Options compared, then the person decides"). Asked for yours? Recommend and continue.
Show real data with builders: \`tools.blocks({ op })\`, op diff, excerpt, changeSet, commandRun or testReport, returns a ready fence; paste it, add notes.`,
  `Short form: a fence naming one component holds just its props, as one JSON object:
${FENCE}gitspace-ui CallDiff id=cache-path
{"title":"…","lines":[…]}
${FENCE}
After the component, optionally: id=<id> (once per message); ask invites a response; ask=required (needs an id) makes it a question the workspace shows as Needs you; their pick comes with their next message. There is no ask tool and nothing waits; if they write in the chat instead, the question closes.`,
  `Props (each JSON is a valid short-form body; "also" names optional fields):
${BRIEF_SHAPES.map((shape) => `- ${shape.component}${shape.options === undefined ? '' : ` ${shape.options}`} ${JSON.stringify(shape.props)}${shape.also === undefined ? '' : `; also: ${shape.also}`}`).join('\n')}`,
  'Anything else (layouts, state, actions, other components) and example replies: read skill://gitspace-ui. GitSpace checks every block; an invalid one in your reply gets a fix step (fix_block), and a tool write holding one is refused. A person\'s comments on your message arrive as "Comment on “…”: …" lines with { "comment": { "id" } }; answer each with its own Reply block, then go on.',
].join('\n\n');

/** The skill's description: what an agent sees in a skill list, so it names the moments to read the skill. */
export const UI_SKILL_DESCRIPTION = 'The reference for GitSpace blocks beyond the drawing brief: layouts with children, state and actions, refs, Sequences, every component\'s props, actions and expressions, worked examples, and example replies for common situations. Read before you draw a block the brief does not cover.';

/** The reference for writing blocks; the body of the `gitspace-ui` skill. It adds to `UI_BLOCK_BRIEF` and repeats none of
 * it. */
export function uiBlockPrompt(): string {
  const fence = FENCE;
  const componentLines = [...componentByType].map(([name, component]) => {
    const named = component.slots?.filter((slot) => slot !== 'default') ?? [];
    const children = component.slots === undefined ? '' : ` [children${named.length > 0 ? `; slots: ${named.join(', ')}` : ''}]`;
    return `- ${name} ${renderSchema(z.toJSONSchema(component.props, { io: 'input' }))} — ${component.description}${children}`;
  });
  const actionLines = [...actionByName].map(([name, action]) => `- ${name} ${renderSchema(z.toJSONSchema(action.params, { io: 'input' }))} — ${action.description}${Object.hasOwn(builtInActions, name) ? ' (built in)' : ''}`);
  const functionLines = Object.entries(functions).map(([name, fn]) => `- ${name}: ${fn.description}`);
  const examples = UI_BLOCK_EXAMPLES.map((example) => `### ${example.title}\n${example.when}\n${fence}${example.fence}\n${example.body}\n${fence}`).join('\n\n');
  const replies = UI_REPLY_EXAMPLES.map((example) => `### ${example.title}\n_${example.situation}_\n\n${example.reply}`).join('\n\n');
  return `The reference for GitSpace blocks. The drawing brief in your instructions has when to draw, the short form, the props of the most used components, asks, fixes and comments; this has the rest.

## Forms
- Short form, for one component: ${fence}gitspace-ui <Component> [id=<id>] [ask|ask=required], holding the component's props as one JSON object. GitSpace reads it as the full form with one element, key "block": { "type": "<Component>", "props": <the JSON>, "children": [], "id"?, "ask"? } and empty state. A short-form AskCard gives question, options and optionally prompt and questionId (the id when omitted); GitSpace binds its pick, its staged, sent and answered state and its answer. An unknown component is refused with the closest names.
- Full form, for layouts (children, slots, state, actions, repeat): ${fence}gitspace-ui with ONE JSON object { "root", "elements", "state" } (Spec below).
- ${fence}svg: one <svg> drawing (SVG rules below).
- ${fence}mermaid: a Mermaid diagram, at most 16 KiB.

A problem's path, such as \`block 2/elements/table/props/columns/0/align\`, counts blocks in order among these fences, then points into the full form (a short-form block's element is "block").

Every block has Copy as Markdown beside its expand button: the person gets the block as plain Markdown (a table, a list, a code or diff fence) to paste into Slack or GitHub, so draw even when they will paste your answer elsewhere. A CallDiff's \`language\` also takes the short names Markdown fences use (ts, js, py, sh, yml, md…). A Tradeoffs \`note\` is one short line under the comparison: how it was scored, or what a score depends on.

## Other components
- Where numbers came from: a RunTag. Parts of a total: a Chart with kind "stacked".
- How code or data flows, what a change rewires, an architecture: a FlowMap.
- A plan or checks the person goes through: a Checklist.
- A choice made with a card's own controls: a full-form Card whose button stages the choice (the example below).
- A spend against a limit: Budget. Log lines: LogTable. Checks by platform or run: CheckGrid. Items the person puts in order: Rank.
- Work in phases with its PRs and issues: Roadmap. Workspaces and what each waits on: WorkspaceGraph.
- A picture or a clip from the drive or a browser capture: Image, Video. Before and after: BeforeAfter.
- Layout, geometry, a UI mockup, or a drawing the components cannot express: ${fence}svg. ${fence}mermaid only for the most basic flow, or when the work is already about Mermaid; anything more is a FlowMap or SVG.
- Real code, a change, a command or a test run: Diff, CodeExcerpt, ChangeSet, CommandRun, TestReport, made by the builders below.

## Builders
Show real data, never retyped: the \`blocks\` tool (tools.blocks({ op, … }) from a script) reads the source and answers JSON { component, props, fence }, the props already checked. Paste \`fence\` into your reply as it is and write your notes around it; a call that cannot read its source fails and says why, rather than inventing data.
- diff { path, base? } → Diff: one file's changes in the workspace's cloud working copy against its merge base with the project's base branch (or the branch \`base\`), with every hunk. A patch over 32 KiB is refused: show the parts that matter with excerpt.
- excerpt { path, start, end, commit?, highlight?, note? } → CodeExcerpt: lines start to end (at most 120) of the file in the working copy, or at \`commit\` (a full commit id); a file unchanged since HEAD is pinned to HEAD's commit. highlight marks lines by their number; note is one line under them.
- changeSet { base? } → ChangeSet: every file changed against the same base, with its status and +/- counts, grouped by area: its top-level package (the first of its one- and two-deep folders holding package.json, go.mod, Cargo.toml, pyproject.toml or another manifest), else its top-level folder.
- commandRun { jobId } or { process, on? } → CommandRun: a finished bash job of this conversation (the "job:…" id its handle names) or an exited proc process: its command, exit code, duration and its last 60 lines of output.
- testReport { jobId } or { process, on? } → TestReport: the passed, failed and skipped counts, failures (name, file, message) and flaky tests of a finished test run, read from the summaries of vitest, bun test, jest, pytest and go test. Output none of them wrote answers \`unrecognised: true\`: only the counts it states in words (null where it states none), no failures, and a note saying so.

## Example replies
Whole replies for common situations, all about one fictional app, Shelf. Each reads the same way: a sentence or two, then the block, then what it means or what comes next. Blocks are in the short form; TestReport, CommandRun and ChangeSet are pasted as tools.blocks returns them.

${replies}

## Examples
Each passes GitSpace's checks; copy their shape.

${examples}

## Spec
- "root": the key of the root element: a Card, an AskCard when the block is one question for the person, a Sequence, or a Reply answering a comment.
- "elements": element key → { "type", "props", "children": [keys], "slots"?: { "<slot>": [keys] }, "visible"?, "repeat"?, "on"?, "id"?, "ask"? }. Every element has "children" ([] for a leaf). "visible", "repeat", "on", "id" and "ask" sit beside "props", never inside it. Put default-slot children in "children", never in slots.default.
- "state": the data the block reads. Seed every path a $state or repeat reads. At most ${MAX_ELEMENTS} elements and ${MAX_SPEC_BYTES / 1024} KiB.

## Ids, refs and asks
- "id": used once in its document: one chat message, one Change Guide, one goal. A BlockRef { "id" } or a Sequence frame { "ref": "<id>" } draws that element again, with its own state, so you never copy a block to show it twice. A ref to another document's element is "<document>#<id>".
- "ask": { "required": true | false, "prompt"?: "<one line>" } in the full form. A required ask shows in the workspace's questions, and the person answers through the block's own choice (an AskCard option, or a button that stages). An optional ask creates no question. Ask only on blocks in your chat messages.

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
- SVG (a ${fence}svg block or the Svg component's literal svg string): one <svg> root; only ${[...SVG_ELEMENTS].join(', ')}; every attribute value quoted; no comments, CDATA or DOCTYPE; no script, style, foreignObject or on* attributes; href only a local "#id"; colours (fill, stroke, color, stop-color, also inside style) currentColor, none or a theme variable such as ${SVG_THEME_VARIABLES.map((name) => `var(${name})`).join(', ')}, and url(#id) for fill and stroke, so the drawing follows the light and dark theme; a literal colour (hex, rgb(), hsl() or a CSS name) is stored as the nearest theme variable; at most ${MAX_SVG_BYTES / 1024} KiB.`;
}
