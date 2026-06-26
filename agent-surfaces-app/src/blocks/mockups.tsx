import { useState, type FC, type ReactNode } from 'react';

// Deterministic "scramble + write-out" effect — same (text, frame) → same output.
const GLYPHS = '!<>-_\\/[]{}=+*^?#'.split('');
function scramble(text: string, frame: number): string {
  const reveal = Math.min(frame, text.length);
  return text.split('').map((c, i) => (i < reveal ? c : GLYPHS[(i * 7 + frame * 3) % GLYPHS.length])).join('');
}

// A real interactive mini React app — this is the "mockup artifact" embedded in the goal doc.
const EffectPreview: FC = () => {
  const [text, setText] = useState('GITSPACE');
  const [frame, setFrame] = useState(7);
  return (
    <div className="effprev">
      <div className="effprev-screen">{scramble(text, frame) || ' '}</div>
      <label className="effprev-field">text<input value={text} onChange={(e) => setText(e.target.value.toUpperCase())} /></label>
      <label className="effprev-field">frame · {frame}<input type="range" min={0} max={20} value={frame} onChange={(e) => setFrame(Number(e.target.value))} /></label>
      <div className="effprev-note">deterministic over the frame clock — same text + frame always renders the same output</div>
    </div>
  );
};

export const MOCKUP_APPS: Record<string, FC> = {
  'effect-preview': EffectPreview,
};

interface Pin { x: number; y: number; who: string; text: string }

// agentation.dev feedback layer — comment pins + jam mode over the live mock.
export function AgentationFrame({ title, artifact, children }: { title: string; artifact: string; children: ReactNode }) {
  const [pins, setPins] = useState<Pin[]>([
    { x: 26, y: 30, who: 'you', text: 'denser scramble at low frames?' },
    { x: 72, y: 64, who: 'agent', text: 'determinism confirmed — frame 7 is stable across reloads' },
  ]);
  const [jam, setJam] = useState(false);
  const place = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!jam) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    setPins((p) => [...p, { x, y, who: 'you', text: 'new note' }]);
  };
  return (
    <div className="mockup">
      <div className="mockup-bar">
        <span className="mk-dot" /><span className="mk-title">{title}</span>
        <span className="mk-art">artifact · {artifact}</span>
        <span className="mk-spacer" />
        <button className={`mk-jam ${jam ? 'on' : ''}`} onClick={() => setJam((j) => !j)}>agentation · {jam ? 'click to pin' : 'jam'}</button>
      </div>
      <div className={`mockup-stage ${jam ? 'jamming' : ''}`} onClick={place}>
        {children}
        {pins.map((p, i) => (
          <span key={i} className={`mk-pin ${p.who}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} title={`${p.who}: ${p.text}`}>{i + 1}</span>
        ))}
      </div>
      <div className="mockup-foot">
        <span className="mk-count">{pins.length} comments</span>
        <span className="mk-hint">{jam ? 'jam mode — click the mock to drop a pin' : 'agentation.dev installed — turn on jam to leave feedback'}</span>
      </div>
    </div>
  );
}
