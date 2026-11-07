// A gitspace-ui block: a json-render spec checked with GitSpace's validator, then drawn with the block registry. Each
// block keeps its own json-render state, seeded from the spec's `state`; its actions run the surface's BlockActions.
import { gitspaceUiCatalog, validateUiSpec, type UiBlockIssue } from '@gitspace/protocol/gitspace-ui';
import { createStateStore, type Spec, type StateStore } from '@json-render/core';
import { JSONUIProvider, Renderer, defineRegistry, useStateValue, type Actions } from '@json-render/react';
import { InfoCircle } from '@untitledui/icons';
import { useEffect, useMemo, useRef } from 'react';
import type { z } from 'zod';
import { useBlockActions, type BlockActionName, type BlockActions, type BlockState } from './BlockActions.js';
import { BlockErrorCard } from './BlockFrames.js';
import { BLOCK_COMPONENTS, blockCatalog, blockFunctions } from './registry.js';
import { SvgBlock } from './SvgBlock.js';

/** The validator checked the shape `Renderer` reads: { root, elements, state? } with catalog components only. */
function conforms(spec: unknown, issues: readonly UiBlockIssue[]): spec is Spec {
  return issues.length === 0;
}

export function UiBlock({ spec, source }: { spec: unknown; source?: string }) {
  const json = useMemo(() => source ?? JSON.stringify(spec, null, 2), [spec, source]);
  const issues = useMemo(() => validateUiSpec(spec), [spec]);
  if (!conforms(spec, issues)) return <BlockErrorCard issues={issues} source={json} sourceLabel="JSON" />;
  // A changed spec is a new block, with its state seeded again.
  return <DrawnBlock key={json} spec={spec} />;
}

/** The body of a ```gitspace-ui or ```svg fence. */
export function FencedBlock({ kind, body }: { kind: 'gitspace-ui' | 'svg'; body: string }) {
  return kind === 'svg' ? <SvgBlock svg={body} /> : <JsonFence body={body} />;
}

function JsonFence({ body }: { body: string }) {
  const parsed = useMemo((): { spec: unknown } | { error: string } => {
    try {
      return { spec: JSON.parse(body) };
    } catch (error) {
      return { error: `the gitspace-ui block is not JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }, [body]);
  if ('error' in parsed) return <BlockErrorCard issues={[{ path: '', message: parsed.error }]} source={body} sourceLabel="JSON" />;
  return <UiBlock spec={parsed.spec} source={body} />;
}

function DrawnBlock({ spec }: { spec: Spec }) {
  const actions = useBlockActions();
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; }, [actions]);
  const store = useMemo(() => createStateStore(structuredClone(spec.state ?? {})), [spec]);
  // json-render keeps the handlers it mounted with, so they read the surface's current actions through the ref.
  const { registry, handlers } = useMemo(() => {
    const defined = defineRegistry(blockCatalog, { components: BLOCK_COMPONENTS, actions: blockActions(store, () => actionsRef.current) });
    return { registry: defined.registry, handlers: defined.handlers(() => undefined, store.getSnapshot) };
  }, [store]);
  return <JSONUIProvider registry={registry} store={store} handlers={handlers} functions={blockFunctions}>
    <div data-gitspace-block="gitspace-ui" className="my-2 flex min-w-0 flex-col gap-1.5">
      <Renderer spec={spec} registry={registry} />
      <Notices />
    </div>
  </JSONUIProvider>;
}

interface Notice { id: string; text: string }

function isNotice(value: unknown): value is Notice {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'text' in value && typeof value.text === 'string';
}

/** What GitSpace wrote to /gitspaceNotices: actions that are not available here or failed. */
function Notices() {
  const value = useStateValue<unknown>('/gitspaceNotices');
  const notices = Array.isArray(value) ? value.filter(isNotice) : [];
  if (notices.length === 0) return null;
  return <ul aria-label="Block notices" className="flex flex-col gap-0.5 px-1">
    {notices.map((notice) => <li key={notice.id} className="flex items-center gap-1.5 text-caption text-muted-foreground"><InfoCircle width={13} height={13} className="shrink-0" />{notice.text}</li>)}
  </ul>;
}

function pointerSegment(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

let noticeCount = 0;

function blockState(store: StateStore): BlockState {
  return {
    setStaged: (key, label) => store.set(`/staged/${pointerSegment(key)}`, label),
    setSent: (key, label) => store.set(`/sent/${pointerSegment(key)}`, label),
    setAnswered: (label) => store.set('/answered', label),
    notify: (text) => {
      noticeCount += 1;
      const previous = store.get('/gitspaceNotices');
      store.set('/gitspaceNotices', [...(Array.isArray(previous) ? previous : []), { id: `notice-${noticeCount}`, text }]);
    },
    set: (path, value) => store.set(path, value),
  };
}

const ACTION_LABELS: Record<BlockActionName, string> = {
  stage: 'Adding to your message',
  record_decision: 'Recording a decision',
  send_to_agent: 'Sending to the agent',
  open_guide_section: 'Opening the Change Guide',
  accept_requirement: 'Accepting a requirement',
  answer_question: 'Answering',
  open_url: 'Opening links',
};

/** The catalog's actions for one block. json-render resolves the params' expressions; runAction checks the result. */
function blockActions(store: StateStore, current: () => BlockActions | null): Actions<typeof blockCatalog> {
  const block = blockState(store);
  const { actions } = gitspaceUiCatalog;
  return {
    stage: (params) => runAction('stage', actions.stage.params, params, current()?.stage, block),
    record_decision: (params) => runAction('record_decision', actions.record_decision.params, params, current()?.record_decision, block),
    send_to_agent: (params) => runAction('send_to_agent', actions.send_to_agent.params, params, current()?.send_to_agent, block),
    open_guide_section: (params) => runAction('open_guide_section', actions.open_guide_section.params, params, current()?.open_guide_section, block),
    accept_requirement: (params) => runAction('accept_requirement', actions.accept_requirement.params, params, current()?.accept_requirement, block),
    answer_question: (params) => runAction('answer_question', actions.answer_question.params, params, current()?.answer_question, block),
    open_url: (params) => runAction('open_url', actions.open_url.params, params, current()?.open_url, block),
  };
}

/** Parses the params with the catalog's schema and runs the surface's handler; anything else is a notice under the block. */
async function runAction<P>(name: BlockActionName, schema: z.ZodType<P>, raw: unknown, handler: ((params: P, block: BlockState) => void | Promise<void>) | undefined, block: BlockState): Promise<void> {
  if (handler === undefined) {
    block.notify(`${ACTION_LABELS[name]} is not available here.`);
    return;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    block.notify(`${ACTION_LABELS[name]} failed: ${parsed.error.issues.map((issue) => `${issue.path.join('/') || 'params'}: ${issue.message}`).join('; ')}`);
    return;
  }
  try {
    await handler(parsed.data, block);
  } catch (error) {
    block.notify(`${ACTION_LABELS[name]} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
