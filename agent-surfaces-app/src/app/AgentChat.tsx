import { useMemo, useState } from 'react';
import { BlockView } from '../blocks';
import { Md } from '../Md';
import { agentDemo, CHAT_MODELS, SLASH_COMMANDS, MENTION_TARGETS } from '../data/mock';
import type { ChatItem } from '../data/mock';
import { AccountPanel, ModelPanel, AgentPanel, UsagePanel, ContextPanel, GeneralSettings } from './AgentSettings';

const STATUS_TONE: Record<string, string> = { running: 'amber', done: 'green', error: 'red', fallback: 'amber' };

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ci-think">
      <button className="ci-think-h" onClick={() => setOpen((o) => !o)}>
        <span className={`caret ${open ? 'open' : ''}`}>▶</span> thinking
      </button>
      {open && <div className="ci-think-b">{text}</div>}
    </div>
  );
}

function ToolCard({ it }: { it: Extract<ChatItem, { kind: 'tool' }> }) {
  const hasBody = !!(it.out || it.diff || it.todo || it.img);
  const [open, setOpen] = useState(!!it.diff || !!it.todo || !!it.img);
  return (
    <div className="ci-tool">
      <div className="ci-tool-h" onClick={() => hasBody && setOpen((o) => !o)}>
        {hasBody && <span className={`caret ${open ? 'open' : ''}`}>▶</span>}
        <span className="ci-tool-name mono">{it.tool}</span>
        {it.target && <span className="ci-tool-target mono dim">{it.target}</span>}
        <span className="ci-tool-meta">
          {it.status === 'running' && <span className="wdot running" />}
          {it.meta && <span className="dim mono">{it.meta}</span>}
          <span className={`chip ${STATUS_TONE[it.status]}`}>{it.status}</span>
        </span>
      </div>
      {open && hasBody && (
        <div className="ci-tool-b">
          {it.out && <pre className="rc-pre">{it.out}</pre>}
          {it.diff && <div className="code">{it.diff.map((l, i) => <div key={i} className={`codeln ${l.kind}`}><span className="g">{l.ln ?? ''}</span><span className="s">{l.text}</span></div>)}</div>}
          {it.todo && <div className="ci-todo">{it.todo.map((t, i) => <div key={i} className={`ci-todo-row ${t.done ? 'done' : ''}`}><span className="ci-todo-box">{t.done ? '✓' : '○'}</span>{t.text}</div>)}</div>}
          {it.img && <img className="ci-img" src={it.img} alt="" />}
        </div>
      )}
    </div>
  );
}

function Item({ it }: { it: ChatItem }) {
  switch (it.kind) {
    case 'user':
      return <div className="chat-msg user"><span className="who user">you</span>{it.text}{it.atts && <span className="ci-atts">{it.atts.map((a) => <span key={a} className="chip dim">📎 {a}</span>)}</span>}</div>;
    case 'assistant':
      return <div className="chat-msg agent"><span className="who agent">agent</span><Md>{it.md}</Md></div>;
    case 'thinking':
      return <Thinking text={it.text} />;
    case 'tool':
      return <ToolCard it={it} />;
    case 'mermaid':
      return <div className="ci-mermaid"><BlockView block={{ id: 'm', type: 'mermaid', data: { code: it.code } }} /></div>;
    case 'image':
      return <div className="ci-output"><img className="ci-img" src={it.src} alt="" />{it.caption && <div className="dim mono ci-cap">{it.caption}</div>}</div>;
    case 'subagent':
      return (
        <div className="ci-sub">
          <div className="ci-sub-h"><span className="wdot running" /><span className="mono">✦ {it.label}</span><span className="dim mono">{it.model}</span><span className="chip amber">{it.status}</span></div>
          <div className="ci-sub-b">{it.lines.map((l, i) => <div key={i} className="ci-sub-line dim">→ {l}</div>)}</div>
        </div>
      );
    case 'permission':
      return (
        <div className="ci-perm">
          <div className="ci-perm-h">⚠ permission needed</div>
          <div className="ci-perm-cmd mono">{it.tool} · {it.detail}</div>
          <div className="ci-perm-actions"><button className="btn primary xs">Allow once</button><button className="btn xs">Always allow</button><button className="btn xs">Deny</button></div>
        </div>
      );
    case 'hostui':
      return (
        <div className="ci-hostui">
          <div className="ci-hostui-h">◆ agent asks <span className="dim">· {it.dialog}</span></div>
          <div className="ci-hostui-prompt">{it.prompt}</div>
          {it.dialog === 'select' && <div className="ci-hostui-opts">{it.options?.map((o) => <button key={o} className="btn xs">{o}</button>)}</div>}
          {it.dialog === 'confirm' && <div className="ci-hostui-opts"><button className="btn primary xs">Yes</button><button className="btn xs">No</button></div>}
          {it.dialog === 'input' && <div className="ci-hostui-opts"><input className="cmp-in" style={{ flex: 1 }} placeholder="type a response…" /><button className="btn primary xs">Send</button></div>}
        </div>
      );
    case 'error':
      return <div className={`ci-error ${it.aborted ? 'aborted' : ''}`}><span className="ci-error-ic">{it.aborted ? '◼' : '⚠'}</span>{it.text}{!it.aborted && <button className="btn xs ci-error-retry">Retry</button>}</div>;
  }
}

function Composer() {
  const [text, setText] = useState('Refute the proxy-trap finding, or fix it');
  const last = text.slice(text.lastIndexOf(' ') + 1);
  const slash = last.startsWith('/') ? SLASH_COMMANDS.filter((c) => c.name.startsWith(last.slice(1))) : [];
  const at = last.startsWith('@') ? MENTION_TARGETS.filter((t) => t.token.toLowerCase().startsWith(last.slice(1).toLowerCase())) : [];
  const complete = (val: string) => setText(text.slice(0, text.lastIndexOf(' ') + 1) + val + ' ');
  return (
    <div className="composer">
      {(slash.length > 0 || at.length > 0) && (
        <div className="cmp-menu">
          {slash.map((c) => <button key={c.name} className="cmp-item" onMouseDown={() => complete('/' + c.name)}><span className="mono">/{c.name}</span><span className="dim">{c.blurb}</span></button>)}
          {at.map((t) => <button key={t.token} className="cmp-item" onMouseDown={() => complete('@' + t.token)}><span className="mono">@{t.token}</span><span className="dim">{t.kind}</span></button>)}
        </div>
      )}
      <div className="composer-top">
        <span className="chip dim">＋ attach</span>
        <span className="chip dim">/ commands</span>
        <span className="chip dim">@ mention</span>
        <span className="chip violet">workflow</span>
      </div>
      <textarea className="cmp-in" value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <div className="composer-q"><span className="wdot pending" />1 message queued — sends when review-gate returns<span className="cmp-send"><button className="btn primary sm">Send</button></span></div>
    </div>
  );
}

const PANEL_TITLE: Record<string, string> = { account: 'Sign in to OMP', general: 'General settings', model: 'Model configuration', agent: 'Agent configuration', usage: 'Usage & limits', ctx: 'Context usage' };

export function AgentChat() {
  const [model, setModel] = useState(CHAT_MODELS[0]);
  const [modelMenu, setModelMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  const items = useMemo(() => agentDemo, []);

  return (
    <div className="chat">
      <div className="chat-hdr">
        <span className="chat-hdr-rel">
          <button className="chat-model" onClick={() => { setModelMenu((m) => !m); setSettings(false); }}>✦ {model.label} ▾</button>
          {modelMenu && (
            <div className="chat-menu">
              {CHAT_MODELS.map((m) => (
                <button key={m.id} className={`chat-menu-item ${m.id === model.id ? 'on' : ''}`} onClick={() => { setModel(m); setModelMenu(false); }}>
                  <span>{m.label}</span><span className="dim">{m.sub}</span>{m.id === model.id && <span className="chat-menu-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="chat-ctx" title="context window">
          <span className="dim">ctx</span>
          <span className="chat-ctx-bar"><span className="chat-ctx-fill" style={{ width: '42%' }} /></span>
          <span className="mono dim">84k / 200k</span>
        </span>
        <span className="chat-usage mono dim">session 1.2M · $4.10</span>
        <span className="chat-hdr-rel" style={{ marginLeft: 'auto' }}>
          <button className="chat-gear" onClick={() => { setSettings((s) => !s); setModelMenu(false); }}>⚙</button>
          {settings && (
            <div className="chat-menu right">
              {Object.entries(PANEL_TITLE).map(([k, label]) => (
                <button key={k} className="chat-menu-item" onClick={() => { setPanel(k); setSettings(false); }}>{label}</button>
              ))}
            </div>
          )}
        </span>
      </div>

      <div className="chat-scroll">
        {items.map((it, i) => <Item key={i} it={it} />)}
      </div>

      <Composer />

      {panel && (
        <div className="chat-panel-scrim" onClick={() => setPanel(null)}>
          <div className="chat-panel wide" onClick={(e) => e.stopPropagation()}>
            <div className="chat-panel-h">{PANEL_TITLE[panel]}<button className="chat-panel-x" onClick={() => setPanel(null)}>✕</button></div>
            <div className="chat-panel-b">
              {panel === 'account' && <AccountPanel />}
              {panel === 'general' && <GeneralSettings />}
              {panel === 'model' && <ModelPanel />}
              {panel === 'agent' && <AgentPanel />}
              {panel === 'usage' && <UsagePanel />}
              {panel === 'ctx' && <ContextPanel />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
