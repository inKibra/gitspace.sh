import { useEffect, useRef, useState } from 'react';
import { reviewWalkthrough } from '../../data/mock';
import type { Workspace } from '../../data/mock';
import { usePaneActions } from '../../blocks/pane-actions';

export function ReviewStage({ ws }: { ws: Workspace }) {
  void ws;
  const steps = reviewWalkthrough;
  const [active, setActive] = useState(0);
  const [done, setDone] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<(HTMLElement | null)[]>([]);
  const { open } = usePaneActions();

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const recompute = () => {
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) { setActive(secRefs.current.length - 1); return; }
      const line = root.getBoundingClientRect().top + 72;
      let idx = 0;
      secRefs.current.forEach((el, i) => { if (el && el.getBoundingClientRect().top <= line) idx = i; });
      setActive(idx);
    };
    recompute();
    root.addEventListener('scroll', recompute, { passive: true });
    return () => root.removeEventListener('scroll', recompute);
  }, []);

  const go = (i: number) => secRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const toggle = (i: number) => setDone((d) => { const n = new Set(d); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const step = steps[active];

  return (
    <div className="rg">
      <div className="rg-left">
        <div className="rg-head">Change Guide · the PR as a story</div>
        <div className="rg-timeline">
          {steps.map((s, i) => (
            <button key={i} className={`rg-step ${active === i ? 'on' : ''} ${done.has(i) ? 'done' : ''}`} onClick={() => go(i)}>
              <span className="rg-dot" /><span className="rg-num">{done.has(i) ? '✓' : s.n}</span>{s.title}
            </button>
          ))}
        </div>
        <div className="rg-prog">{done.size} / {steps.length} phases reviewed</div>
        <div className="rg-explain">
          {step && (
            <>
              <div className="rg-kind">{step.kind}</div>
              <p className="rg-what">{step.what}</p>
              <p className="rg-why"><span className="rg-whyk">why</span>{step.why}</p>
            </>
          )}
        </div>
        <div className="rg-foot">
          <button className="btn sm" onClick={() => open('rubric')}>☰ Review rubric</button>
          <button className="btn primary sm">{done.size === steps.length ? 'Approve' : `Approve · ${done.size}/${steps.length}`}</button>
        </div>
      </div>

      <div className="rg-right" ref={scrollRef}>
        {steps.map((s, i) => (
          <section key={i} data-idx={i} ref={(el) => { secRefs.current[i] = el; }} className={`rg-sec ${done.has(i) ? 'done' : ''}`}>
            <div className="rg-sec-h">
              <span className="rg-num">{done.has(i) ? '✓' : s.n}</span>
              <span className="rg-sec-t">{s.title}</span>
              <span className="rg-sec-k">{s.kind}</span>
              <button className={`rg-mark ${done.has(i) ? 'on' : ''}`} onClick={() => toggle(i)}>{done.has(i) ? '✓ Complete' : 'Mark complete'}</button>
            </div>
            <div className="rg-sec-b">
              {s.files.map((f, j) => (
                <div key={j} className="rg-file">
                  <div className="rg-file-h">{f.path}</div>
                  <div className="code">{f.lines.map((l, k) => (
                    <div key={k} className={`codeln ${l.kind}`}><span className="g">{l.ln ?? ''}</span><span className="s">{l.text || ' '}</span></div>
                  ))}</div>
                </div>
              ))}
              {s.comment && (
                <div className="thread">
                  <div className={`who ${s.comment.tone}`}>◆ {s.comment.who}</div>
                  <div className="body">{s.comment.text}</div>
                  {s.comment.tone === 'fail' && (
                    <div className="actions"><button className="primary">✦ Send to agent → fix</button><button>Comment</button><button className="danger">Dismiss</button></div>
                  )}
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
