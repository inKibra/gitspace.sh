import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactRef } from '../blocks/types';
import { ArtifactPreview } from './ArtifactPreview';
import {
  reviewRubric,
  type RubricEvidence,
  type RubricJudgement,
  type RubricVerdict,
} from '../data/mock';

const V_CHIP: Record<RubricVerdict, string> = { pass: 'green', fail: 'red', partial: 'amber', pending: 'dim' };
const V_LABEL: Record<RubricVerdict, string> = { pass: 'pass', fail: 'fail', partial: 'partial', pending: 'pending' };
const JUDGE_ICON: Record<string, string> = { human: '◆', llm: '✦', command: '❯' };
const JUDGE_LABEL: Record<string, string> = { human: 'human', llm: 'agent eval', command: 'command' };
const EV_TONE: Record<string, string> = { command: 'green', screenshot: 'blue', video: 'violet', review: 'amber', note: 'dim', file: 'dim' };

// render the rubric contract text with `code` spans
const contract = (text: string) => text.split('`').map((seg, i) => (i % 2 ? <code key={i}>{seg}</code> : seg));

const Preview = ({ refData }: { refData: ArtifactRef }) => <ArtifactPreview refData={refData} />;

function rollup(judgements: RubricJudgement[]): { verdict: RubricVerdict; score?: number } {
  if (judgements.length === 0) return { verdict: 'pending' };
  const verdict: RubricVerdict =
    judgements.some((j) => j.verdict === 'fail') ? 'fail'
    : judgements.some((j) => j.verdict === 'partial' || j.verdict === 'pending') ? 'partial'
    : 'pass';
  const scored = judgements.filter((j) => typeof j.score === 'number');
  const score = scored.length ? Math.round(scored.reduce((a, j) => a + (j.score ?? 0), 0) / scored.length) : undefined;
  return { verdict, score };
}

function Score({ value, small }: { value: number; small?: boolean }) {
  const tone = value >= 80 ? 'green' : value >= 50 ? 'amber' : 'red';
  return (
    <span className={`rc-score ${small ? 'sm' : ''}`}>
      <span className="rc-score-bar"><span className={`rc-score-fill ${tone}`} style={{ width: `${value}%` }} /></span>
      <span className="rc-score-num mono">{value}</span>
    </span>
  );
}

function Evidence({ ev }: { ev: RubricEvidence }) {
  return (
    <div className="rc-ev">
      <div className="rc-ev-head">
        <span className={`chip ${EV_TONE[ev.kind] ?? 'dim'}`}>{ev.kind}</span>
        <span className="rc-ev-name mono">{ev.name}</span>
        {ev.meta && <span className="muted rc-ev-meta">— {ev.meta}</span>}
        <span className="rc-ev-ref mono dim" title="artifact ref">{ev.id}</span>
        <span className={`chip ${ev.source === 'captured' ? 'green' : 'amber'} rc-ev-src`}>{ev.source}</span>
      </div>
      <div className="rc-ev-body"><Preview refData={ev.ref} /></div>
    </div>
  );
}

function Judgement({ j }: { j: RubricJudgement }) {
  return (
    <div className="rc-jud-row">
      <span className={`rc-jud-ic ${j.type}`} title={JUDGE_LABEL[j.type]}>{JUDGE_ICON[j.type]}</span>
      <div className="rc-jud-main">
        <div className="rc-jud-top">
          <span className="rc-jud-who">{j.judge}</span>
          <span className="dim rc-jud-kind">{JUDGE_LABEL[j.type]}</span>
          <span className={`chip ${V_CHIP[j.verdict]}`}>{V_LABEL[j.verdict]}</span>
          {typeof j.score === 'number' && <Score value={j.score} small />}
          {j.at && <span className="dim mono rc-jud-at">{j.at}</span>}
        </div>
        <div className="rc-jud-note">{j.note}</div>
        {j.cites && j.cites.length > 0 && (
          <div className="rc-jud-cites">{j.cites.map((c) => <span key={c} className="rc-cite mono">↳ {c}</span>)}</div>
        )}
      </div>
    </div>
  );
}

// ── interactive: cast a human judgement on a gated criterion ──
function MakeJudgement({ onCast }: { onCast: (j: RubricJudgement) => void }) {
  const [verdict, setVerdict] = useState<RubricVerdict | null>(null);
  const [score, setScore] = useState(70);
  const [note, setNote] = useState('');
  return (
    <div className="rc-make">
      <div className="rc-make-h">◆ your judgement <span className="dim">— this criterion is human-gated</span></div>
      <div className="rc-make-row">
        {(['pass', 'partial', 'fail'] as RubricVerdict[]).map((v) => (
          <button key={v} className={`rc-pick ${V_CHIP[v]} ${verdict === v ? 'on' : ''}`} onClick={() => setVerdict(v)}>{V_LABEL[v]}</button>
        ))}
        <label className="rc-make-score">
          score <input type="range" min={0} max={100} value={score} onChange={(e) => setScore(+e.target.value)} />
          <span className="mono rc-make-scorenum">{score}</span>
        </label>
      </div>
      <textarea
        className="rc-make-note"
        placeholder="Why — cite what the evidence on the right does or doesn't prove…"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="rc-make-actions">
        <button
          className="btn primary"
          disabled={!verdict || !note.trim()}
          onClick={() => {
            if (!verdict) return;
            onCast({ judge: 'you', type: 'human', verdict, score, note: note.trim(), at: 'now' });
            setVerdict(null); setNote(''); setScore(70);
          }}
        >Record judgement</button>
      </div>
    </div>
  );
}

export function ReviewRubric() {
  const [extra, setExtra] = useState<Record<string, RubricJudgement[]>>({});
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<(HTMLElement | null)[]>([]);

  const crits = useMemo(() => reviewRubric.map((c) => {
    const judgements = [...c.judgements, ...(extra[c.id] ?? [])];
    const humanCast = (extra[c.id] ?? []).some((j) => j.type === 'human');
    return { c, judgements, roll: rollup(judgements), awaiting: !!c.awaitingHuman && !humanCast };
  }), [extra]);

  // scroll-spy: the criterion the right column is currently showing lights up on the left
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const recompute = () => {
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) { setActive(secRefs.current.length - 1); return; }
      const line = root.getBoundingClientRect().top + 80;
      let idx = 0;
      secRefs.current.forEach((el, i) => { if (el && el.getBoundingClientRect().top <= line) idx = i; });
      setActive(idx);
    };
    recompute();
    root.addEventListener('scroll', recompute, { passive: true });
    return () => root.removeEventListener('scroll', recompute);
  }, []);

  const go = (i: number) => secRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const cast = (id: string, j: RubricJudgement) => setExtra((e) => ({ ...e, [id]: [...(e[id] ?? []), j] }));
  const act = crits[active];

  return (
    <div className="rr2">
      {/* left rail: stays put — the criterion you're reading is always in view */}
      <div className="rr-left">
        <div className="rg-head">Review rubric · the contract</div>
        <div className="rr-index">
          {crits.map((x, i) => (
            <button key={x.c.id} className={`rr-idx ${active === i ? 'on' : ''}`} onClick={() => go(i)}>
              <span className={`rr-dot ${V_CHIP[x.roll.verdict]}`} />
              <span className="rr-idx-t">{x.c.criterion}</span>
              {typeof x.roll.score === 'number' && <span className="rr-idx-score mono">{x.roll.score}</span>}
            </button>
          ))}
        </div>
        <div className="rr-active">
          {act && (
            <>
              <div className="rr-active-badges">
                <span className={`chip ${V_CHIP[act.roll.verdict]}`}>{V_LABEL[act.roll.verdict]}</span>
                {act.c.required && <span className="rc-req">required</span>}
                <span className={`rc-gate ${act.c.gate}`}>{JUDGE_ICON[act.c.gate]} {act.c.gate} gate</span>
              </div>
              <div className="rr-active-t">{act.c.criterion}</div>
              <div className="rr-active-rubric">{contract(act.c.rubric)}</div>
              <div className="rr-active-meta">
                {typeof act.roll.score === 'number' && <Score value={act.roll.score} />}
                <span className="dim">{act.judgements.length} {act.judgements.length === 1 ? 'judge' : 'judges'} · {act.c.evidence.length} evidence</span>
              </div>
              {act.awaiting
                ? <MakeJudgement onCast={(j) => cast(act.c.id, j)} />
                : <div className="rr-judged">{act.c.gate === 'human' ? '◆ your verdict recorded' : `${JUDGE_ICON[act.c.gate]} ${act.c.gate}-gated — no human verdict required`}</div>}
            </>
          )}
        </div>
        <div className="rr-foot">
          <span className="dim mono">{reviewRubric.length} criteria · gated exit owned by human approval</span>
        </div>
      </div>

      {/* right column: scrolls through each criterion's evidence + judgements */}
      <div className="rr-right" ref={scrollRef}>
        {crits.map((x, i) => (
          <section key={x.c.id} ref={(el) => { secRefs.current[i] = el; }} className={`rr-sec ${active === i ? 'on' : ''}`}>
            <div className="rr-sec-h">
              <span className={`chip ${V_CHIP[x.roll.verdict]}`}>{V_LABEL[x.roll.verdict]}</span>
              <span className="rr-sec-t">{x.c.criterion}</span>
              {x.awaiting && <span className="rc-await">awaiting your verdict</span>}
            </div>
            <div className="rr-sec-b">
              <div className="rc-section-h">evidence <span className="dim">· {x.c.evidence.length}</span></div>
              {x.c.evidence.length === 0
                ? <div className="rc-empty">no evidence collected yet</div>
                : x.c.evidence.map((ev) => <Evidence key={ev.id} ev={ev} />)}
              <div className="rc-section-h rr-jud-h">judgements <span className="dim">· {x.judgements.length} {x.judgements.length === 1 ? 'judge' : 'judges'}</span></div>
              {x.judgements.map((j, k) => <Judgement key={k} j={j} />)}
            </div>
          </section>
        ))}
        <div className="callout rc-foot">
          <div className="ct">top-level + per-phase</div>
          This is the workspace's top-level review rubric. Each workflow phase can carry its own <b>mini rubric</b> (e.g. <code>type-review rubric</code>) passed to that phase's reviewer — see the Workflow phase artifacts.
        </div>
      </div>
    </div>
  );
}
