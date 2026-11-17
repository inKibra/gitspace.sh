// A gitspace-ui block: a json-render spec checked with GitSpace's validator, then drawn with the block registry. Each
// block keeps its own json-render state, seeded from the spec's `state`; its actions run the surface's BlockActions. It
// opens in the lightbox, drawn again at the dialog's width from the same state. An element with an id may be drawn
// again by a BlockRef or a Sequence frame of the same document. An element with an ask shows it above the block; a
// required ask in a stored chat message is a workspace question: the block's own choice stages an answer to it, which
// the person's next message carries. A block of a stored chat message takes comments (comments/CommentLayer.tsx) on
// itself, its items and text selected in it, unless it asks a question.
import { askAnswerParts, questionState, type RuntimeQuestion } from '@gitspace/protocol-runtime';
import { blockFunctions, blockMarkdown } from '@gitspace/protocol/block-markdown';
import { blockAskQuestionId, fenceSpec, gitspaceUiCatalog, parseBlockRef, validateUiSpec } from '@gitspace/protocol/gitspace-ui';
import { Badge } from '@gitspace/ui';
import { createStateStore, type Spec, type StateStore } from '@json-render/core';
import { JSONUIProvider, Renderer, defineRegistry, useStateValue, type Actions } from '@json-render/react';
import { InfoCircle, MessageQuestionCircle } from '@untitledui/icons';
import { useContext, useEffect, useMemo, useRef } from 'react';
import type { z } from 'zod';
import { Lightbox } from '../Lightbox.js';
import { CLOSED_REASON, QuestionCardsContext } from '../QuestionCards.js';
import { useBlockActions, type BlockActionName, type BlockActions, type BlockState } from './BlockActions.js';
import { BlockDocument, BlockQuestionClosed, BlockRendering, BlockStagedAnswer, OtherDocumentRef, blockingIssues, conforms, type BlockRenderingValue } from './BlockDocument.js';
import { BlockErrorCard } from './BlockFrames.js';
import { BLOCK_COMPONENTS, blockCatalog } from './registry.js';
import { CopyMarkdownButton } from './CopyMarkdown.js';
import { SvgBlock } from './SvgBlock.js';
import { BlockCommentButton, BlockMarker, CommentBlock, blockKey, type CommentBlockValue } from '../comments/CommentLayer.js';
import { useComposerStaging } from '../chat/staging.js';

const NO_REFS: readonly string[] = [];

export function UiBlock({ spec, source }: { spec: unknown; source?: string }) {
  const json = useMemo(() => source ?? JSON.stringify(spec, null, 2), [spec, source]);
  const issues = useMemo(() => validateUiSpec(spec), [spec]);
  // A Sequence draws around a frame that fails the checks: that frame shows its own error card.
  if (!conforms(spec, blockingIssues(issues))) return <BlockErrorCard issues={issues} source={json} sourceLabel="JSON" />;
  // A changed spec is a new block, with its state seeded again.
  return <DrawnBlock key={json} spec={spec} refs={NO_REFS} />;
}

/** An element of the document drawn again by ref, with its own state; a block never draws itself inside itself. The
 * block the ref is in is part of the document also where no surface names the document. */
function RefBlock({ reference, refs, within }: { reference: string; refs: readonly string[]; within: Spec }) {
  const target = parseBlockRef(reference);
  const listed = useContext(BlockDocument).targets.get(target?.id ?? '');
  const chain = useMemo(() => [...refs, reference], [refs, reference]);
  const spec = useMemo(() => {
    if (listed) return { ...listed.spec, root: listed.key };
    const own = Object.entries(within.elements).find(([, element]) => 'id' in element && element.id === target?.id);
    return own ? { ...within, root: own[0] } : null;
  }, [listed, within, target?.id]);
  if (target !== null && target.document !== null) return <OtherDocumentRef document={target.document} id={target.id} />;
  const problem = refs.includes(reference) ? `block "${reference}" would draw itself` : spec === null ? `no block with id "${reference}" in this document` : null;
  if (problem !== null || spec === null) return <BlockErrorCard issues={[{ path: '', message: problem ?? '' }]} source={JSON.stringify({ ref: reference }, null, 2)} sourceLabel="JSON" />;
  return <DrawnBlock spec={spec} refs={chain} />;
}

/** The body of a ```gitspace-ui or ```svg fence; `info` is the info string after the kind (a short-form component). */
export function FencedBlock({ kind, body, info }: { kind: 'gitspace-ui' | 'svg'; body: string; info: string }) {
  return kind === 'svg' ? <SvgBlock svg={body} /> : <JsonFence body={body} info={info} />;
}

function JsonFence({ body, info }: { body: string; info: string }) {
  const read = useMemo(() => fenceSpec(body, info), [body, info]);
  if ('issue' in read) return <BlockErrorCard issues={[read.issue]} source={body} sourceLabel="JSON" />;
  return <UiBlock spec={read.spec} source={body} />;
}

/** What an element of the block asks of the person. */
interface BlockAsk { id: string | null; required: boolean; prompt: string | null }

/** The workspace question a required ask of this block posted, and the ask: found once the message is stored. */
interface AskQuestion { ask: BlockAsk & { id: string }; question: RuntimeQuestion }

function DrawnBlock({ spec, refs }: { spec: Spec; refs: readonly string[] }) {
  const surface = useBlockActions();
  const { messageId, targets, entity } = useContext(BlockDocument);
  const cards = useContext(QuestionCardsContext);
  // A block drawn again by ref shows its content only; its asks belong to where it was written.
  const asks = useMemo((): BlockAsk[] => refs.length > 0 ? [] : Object.values(spec.elements).flatMap((element) => 'ask' in element && typeof element.ask === 'object' && element.ask !== null ? [{
    id: 'id' in element && typeof element.id === 'string' ? element.id : null,
    required: 'required' in element.ask && element.ask.required === true,
    prompt: 'prompt' in element.ask && typeof element.ask.prompt === 'string' ? element.ask.prompt : null,
  }] : []), [spec, refs]);
  const asked = useMemo((): AskQuestion | null => {
    if (messageId === null || !cards) return null;
    for (const ask of asks) {
      if (!ask.required || ask.id === null) continue;
      const question = cards.questions.find((candidate) => candidate.id === blockAskQuestionId(messageId, ask.id ?? ''));
      if (question) return { ask: { ...ask, id: ask.id }, question };
    }
    return null;
  }, [asks, messageId, cards]);
  // While its question is open, the block's choice stages an answer to it for the person's next message (the
  // workspace's staged answers), which answers it; elsewhere the choice stages in the composer as a chip of its own.
  const staging = useComposerStaging();
  const stagesAnswer = asked !== null && staging !== null && questionState(asked.question) === 'open';
  const stagedAnswer = asked ? staging?.answers.find((answer) => answer.questionId === asked.question.id) : undefined;
  const staged = stagedAnswer ? askAnswerParts(stagedAnswer.answer).map((part) => part.selectedOptions[0] ?? part.customInput).find((label) => label) ?? null : null;
  // Once its question closed unanswered (the person replied in chat, dismissed it, stopped the conversation), the block
  // is locked: it says why, and none of its choices takes an answer or stages one.
  const closed = asked?.question.closed ? CLOSED_REASON[asked.question.closed.reason] : null;
  const actions = useMemo((): BlockActions | null => {
    if (!stagesAnswer || !asked || !staging) return surface;
    const pick = (label: string): Promise<void> => staging.stageAnswer(asked.question.id, [{ id: asked.ask.id, selectedOptions: [label], customInput: null }]);
    return { ...surface, stage: (params) => pick(params.label), answer_question: (params) => pick(params.label), record_decision: (params) => pick(params.choice) };
  }, [surface, asked, staging, stagesAnswer]);
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; }, [actions]);
  const store = useMemo(() => createStateStore(structuredClone(spec.state ?? {})), [spec]);
  // An answered question shows answered in the block, also when the block is drawn again after a reload.
  const answered = asked && questionState(asked.question) === 'answered' ? askAnswerParts(asked.question.answer).map((part) => part.selectedOptions[0] ?? part.customInput).find((label) => label) ?? null : null;
  useEffect(() => {
    if (answered !== null && !store.get('/answered')) store.set('/answered', answered);
  }, [answered, store]);
  // json-render keeps the handlers it mounted with, so they read the surface's current actions through the ref.
  const { registry, handlers } = useMemo(() => {
    const defined = defineRegistry(blockCatalog, { components: BLOCK_COMPONENTS, actions: blockActions(store, () => actionsRef.current) });
    return { registry: defined.registry, handlers: defined.handlers(() => undefined, store.getSnapshot) };
  }, [store]);
  const rendering = useMemo((): BlockRenderingValue => ({ spec, registry, drawRef: (reference) => <RefBlock reference={reference} refs={refs} within={spec} /> }), [spec, registry, refs]);
  const title = spec.elements[spec.root]?.props.title;
  // What comments on this block and its items name: its chat message, or the Goal or Guide entity it is in. A block
  // drawn again by ref is a copy inside another block, whose items take no comments of their own; a question (an
  // AskCard, or an element with a required ask) takes none: it is answered by answering it.
  const owner = messageId ?? entity ?? null;
  const comments = useMemo((): CommentBlockValue | null => {
    if (refs.length > 0 || owner === null) return null;
    const root = spec.elements[spec.root];
    return {
      key: blockKey(owner, root, root && 'id' in root && typeof root.id === 'string' ? root.id : null),
      kind: root?.type ?? 'Block', title: typeof title === 'string' && title ? title : null,
      asks: Object.values(spec.elements).some((element) => element.type === 'AskCard' || ('ask' in element && typeof element.ask === 'object' && element.ask !== null && 'required' in element.ask && element.ask.required === true)),
    };
  }, [spec, refs, owner, title]);
  return <JSONUIProvider registry={registry} store={store} handlers={handlers} functions={blockFunctions}>
    <BlockRendering.Provider value={rendering}><BlockStagedAnswer.Provider value={stagesAnswer ? staged : null}><BlockQuestionClosed.Provider value={closed}><CommentBlock.Provider value={comments}>
      <Lightbox label={typeof title === 'string' && title ? title : 'Block'} mode="fill" className="my-2" actions={<>
        <CopyMarkdownButton markdown={() => blockMarkdown({ ...spec, state: store.getSnapshot() }, (ref) => {
          const listed = targets.get(parseBlockRef(ref)?.id ?? '');
          return listed ? { ...listed.spec, root: listed.key } : undefined;
        })} />
        <BlockCommentButton />
      </>}
        expanded={<div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-1.5"><div inert={closed !== null} className="min-w-0"><Renderer spec={spec} registry={registry} /></div><Notices /></div>}>
        <div data-gitspace-block="gitspace-ui" data-comment-block={comments?.key} data-comment-kind={comments?.kind} data-comment-ask={comments?.asks ? '' : undefined} className="flex min-w-0 flex-col gap-1.5">
          {asks.length > 0 ? <AskMarkers asks={asks} asked={asked} /> : null}
          <div inert={closed !== null} className="min-w-0"><Renderer spec={spec} registry={registry} /></div>
          <Notices />
          <BlockMarker />
        </div>
      </Lightbox>
    </CommentBlock.Provider></BlockQuestionClosed.Provider></BlockStagedAnswer.Provider></BlockRendering.Provider>
  </JSONUIProvider>;
}

/**
 * What a block asks of the person, above it. A required ask reads "Needs your answer" while its workspace question is
 * open with no answer staged (or, with no question, until the block's own choice is staged), "Answer in your message"
 * while one waits for the person's next message, and why when the question closed unanswered. An optional ask is a
 * quiet invitation.
 */
function AskMarkers({ asks, asked }: { asks: readonly BlockAsk[]; asked: AskQuestion | null }) {
  const answered = useStateValue<unknown>('/answered');
  const sent = useStateValue<unknown>('/sent');
  const staged = useStateValue<unknown>('/staged');
  const stagedAnswer = useContext(BlockStagedAnswer);
  const [anySent, anyStaged] = [sent, staged].map((value) => typeof value === 'object' && value !== null && Object.values(value).some((entry) => entry !== null && entry !== undefined && entry !== ''));
  const local = answered || anySent ? 'answered' : anyStaged ? 'staged' : 'open';
  return <div className="flex flex-col gap-1">{asks.map((ask, index) => {
    if (!ask.required) return ask.prompt ? <p key={index} className="flex items-center gap-1.5 px-1 text-caption text-muted-foreground"><MessageQuestionCircle width={13} height={13} className="shrink-0" />{ask.prompt}</p> : null;
    const question = asked?.ask.id === ask.id ? asked.question : null;
    const stored = question ? questionState(question) : local;
    const state = stored === 'open' && question && stagedAnswer !== null ? 'staged' : stored;
    if (state === 'answered' || answered) return null;
    if (question?.closed) return <div key={index} data-block-ask="closed" className="flex flex-wrap items-center gap-2 px-1"><Badge size="compact" variant="dot" color="gray">{CLOSED_REASON[question.closed.reason]}</Badge></div>;
    return <div key={index} data-block-ask={state} className="flex flex-wrap items-center gap-2 px-1">
      <Badge size="compact" variant="dot" color={state === 'open' ? 'orange' : 'amber'}>{state === 'open' ? 'Needs your answer' : 'Answer in your message · send it to finish'}</Badge>
      {ask.prompt && state === 'open' ? <span className="text-caption text-foreground">{ask.prompt}</span> : null}
    </div>;
  })}</div>;
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
