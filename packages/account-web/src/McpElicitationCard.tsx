import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { MCP_ELICITATION_CHOICES, mcpElicitationIssues, mcpElicitationOptions, questionState, RuntimeMcpElicitationAnswerSchema, type RuntimeMcpElicitationContent, type RuntimeMcpElicitationField, type RuntimeMcpElicitationForm, type RuntimeMcpElicitationQuestion, type RuntimeQuestion } from '@gitspace/protocol-runtime';
import { Badge, Button, useShape } from '@gitspace/ui';
import { AlertTriangle, LinkExternal01, Server01 } from '@untitledui/icons';
import { CLOSED_REASON, type QuestionCards } from './QuestionCards.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** A field's value as its control holds it: a text, number, date or choice field's text, a checkbox's state, or a
 * multi-select's chosen values. A field without a value is absent. */
type Draft = string | boolean | string[];
/** A choice field with at most this many options shows as radio buttons; a longer one as a select. */
const RADIO_OPTIONS = 4;
const CONTROL = 'min-h-9 w-full min-w-0 rounded-md border border-border bg-surface-1 px-3 text-body text-foreground';
const INPUT_TYPE: Readonly<Record<'email' | 'uri' | 'date' | 'date-time', string>> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };

/** An ISO date and time as a `datetime-local` input holds it, in the browser's time zone. */
function localDateTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso;
  return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The form's defaults as its controls hold them. */
function prefilled(form: RuntimeMcpElicitationForm): Record<string, Draft> {
  const values: Record<string, Draft> = {};
  for (const [name, field] of Object.entries(form.properties)) {
    if (field.default === undefined) continue;
    if (field.type === 'string') values[name] = field.format === 'date-time' ? localDateTime(field.default) : field.default;
    else if (field.type === 'boolean' || field.type === 'array') values[name] = field.default;
    else values[name] = String(field.default);
  }
  return values;
}

/** The answer the controls make: each field the person set, typed as the form says (a date and time as an ISO string in
 * UTC); a required checkbox or multi-select left alone is false or no choices. */
function formContent(form: RuntimeMcpElicitationForm, values: Readonly<Record<string, Draft>>): RuntimeMcpElicitationContent {
  const content: RuntimeMcpElicitationContent = {};
  for (const [name, field] of Object.entries(form.properties)) {
    const value = values[name];
    const required = form.required?.includes(name) ?? false;
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') content[name] = value;
      else if (required) content[name] = false;
    } else if (field.type === 'array') {
      if (Array.isArray(value)) content[name] = value;
      else if (required) content[name] = [];
    } else if (typeof value !== 'string' || value === '') continue;
    else if (field.type === 'string') content[name] = field.format === 'date-time' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : value;
    else content[name] = Number(value);
  }
  return content;
}

/** One field of a form: its label (title, or its name), required mark, help text and control. `secret` makes a free-text
 * field a password input. */
function McpField({ name, field, required, secret, value, disabled, onChange }: { name: string; field: RuntimeMcpElicitationField; required: boolean; secret: boolean; value: Draft | undefined; disabled: boolean; onChange(value: Draft | null): void }) {
  const id = useId();
  const label = <>{field.title ?? name}{required ? <span className="text-destructive" aria-label="required"> *</span> : null}</>;
  const help = field.description ? <span id={`${id}-help`} className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{field.description}</span> : null;
  const describedBy = field.description ? `${id}-help` : undefined;
  const options = mcpElicitationOptions(field);
  if (field.type === 'boolean') return <div className="flex flex-col gap-1" data-mcp-field={name}>
    <label className="flex items-center gap-2 text-body text-foreground"><input type="checkbox" name={name} checked={value === true} disabled={disabled} aria-describedby={describedBy} onChange={event => onChange(event.target.checked)} />{label}</label>
    {help}
  </div>;
  if (options && (field.type === 'array' || options.length <= RADIO_OPTIONS)) {
    const chosen = Array.isArray(value) ? value : [];
    return <fieldset className="flex min-w-0 flex-col gap-1" data-mcp-field={name} aria-describedby={describedBy}>
      <legend className="text-caption font-medium text-foreground">{label}</legend>
      {help}
      {options.map(option => <label key={option.value} className="flex items-center gap-2 text-body text-foreground [overflow-wrap:anywhere]">
        {field.type === 'array'
          ? <input type="checkbox" name={name} value={option.value} checked={chosen.includes(option.value)} disabled={disabled} onChange={event => onChange(event.target.checked ? options.map(item => item.value).filter(item => item === option.value || chosen.includes(item)) : chosen.filter(item => item !== option.value))} />
          : <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} />}
        {option.title}
      </label>)}
    </fieldset>;
  }
  const text = typeof value === 'string' ? value : '';
  return <div className="flex min-w-0 flex-col gap-1" data-mcp-field={name}>
    <label htmlFor={id} className="text-caption font-medium text-foreground">{label}</label>
    {options
      ? <select id={id} name={name} value={text} disabled={disabled} aria-describedby={describedBy} className={CONTROL} onChange={event => onChange(event.target.value === '' ? null : event.target.value)}>
        <option value="">{required ? 'Choose…' : 'Not set'}</option>
        {options.map(option => <option key={option.value} value={option.value}>{option.title}</option>)}
      </select>
      : <input id={id} name={name} value={text} disabled={disabled} aria-describedby={describedBy} className={CONTROL} autoComplete="off"
        type={field.type === 'string' ? secret ? 'password' : field.format ? INPUT_TYPE[field.format] : 'text' : 'number'}
        step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined}
        onChange={event => onChange(event.target.value === '' ? null : event.target.value)} />}
    {help}
  </div>;
}

/** How an ended elicitation question reads: what the server got (a form's values unless they are withheld), or why it
 * closed. */
function outcome(question: RuntimeQuestion, card: RuntimeMcpElicitationQuestion): ReactNode {
  if (question.answer === null) return question.closed ? CLOSED_REASON[question.closed.reason] : '';
  const answer = RuntimeMcpElicitationAnswerSchema.safeParse(question.answer);
  if (!answer.success) return 'Answered';
  if (answer.data.expired) return 'Nobody answered in time (cancelled)';
  if (answer.data.action === 'decline') return 'Declined';
  if (answer.data.action === 'cancel') return 'Cancelled';
  if (card.request.mode === 'url') return `Done on ${card.host ?? card.request.url}`;
  if (answer.data.withheld || card.secretLooking) return 'Answered (values not shown)';
  const fields = card.request.requestedSchema.properties;
  const values = Object.entries(answer.data.content ?? {});
  return <>Accepted{values.length ? <dl className="mt-1 flex flex-col gap-0.5">
    {values.map(([name, value]) => <div key={name} className="flex min-w-0 gap-1.5"><dt className="shrink-0 text-muted-foreground">{fields[name]?.title ?? name}:</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{Array.isArray(value) ? value.join(', ') : String(value)}</dd></div>)}
  </dl> : null}</>;
}

/**
 * An `mcp-elicitation` card: a person's MCP server asks for input during the agent's call (issue #155). The header names
 * the connection, the server, the tool and the workspace. A form shows the server's fields and answers with their values,
 * checked against the form first; a form that looks like it asks for a secret warns that the values go to the server and
 * takes them in password inputs, and its answer is never shown. A link shows the page's host and opens only when the
 * person clicks it; I finished tells the server the page is done. Decline and Cancel send that action. An ended card is
 * read-only and says how it ended.
 */
export function McpElicitationCard({ question, card, cards }: { question: RuntimeQuestion; card: RuntimeMcpElicitationQuestion; cards: QuestionCards }) {
  const shape = useShape();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const request = card.request;
  const form = request.mode === 'form' ? request.requestedSchema : null;
  const [values, setValues] = useState<Readonly<Record<string, Draft>>>(() => form ? prefilled(form) : {});
  const state = questionState(question);
  const open = state === 'open';
  async function send(selectedOptions: string[], customInput: string | null, operation: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await cards.request({ type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions, customInput }] });
    } catch (failure) { setError(rpcErrorMessage(failure, operation)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || busy) return;
    const content = formContent(form, values);
    const found = mcpElicitationIssues(form, content);
    setIssues(found);
    if (!found.length) void send([], JSON.stringify(content), 'Submit');
  }
  function change(name: string, value: Draft | null) {
    setValues(current => value === null ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== name)) : { ...current, [name]: value });
  }
  const refuse = <>
    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send([MCP_ELICITATION_CHOICES.decline], null, MCP_ELICITATION_CHOICES.decline)}>{MCP_ELICITATION_CHOICES.decline}</Button>
    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send([MCP_ELICITATION_CHOICES.cancel], null, MCP_ELICITATION_CHOICES.cancel)}>{MCP_ELICITATION_CHOICES.cancel}</Button>
  </>;
  const body = <div className={`flex flex-col gap-3 px-4 sm:px-5 ${open ? 'pb-1' : 'pb-3'}`}>
    <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{request.message}</p>
    {request.mode === 'url' ? <div className="flex min-w-0 flex-col gap-1">
      <p className="break-all font-mono text-[15px] font-semibold text-foreground" data-mcp-elicitation-host>{card.host}</p>
      <p className="break-all font-mono text-caption text-muted-foreground">{request.url}</p>
      <p className="text-caption text-muted-foreground">This page belongs to {card.connection}, not GitSpace.</p>
    </div> : null}
    {form && card.secretLooking && open ? <p role="note" className="flex gap-1.5 text-caption text-foreground [overflow-wrap:anywhere]" data-mcp-elicitation-secret>
      <AlertTriangle className="mt-0.5 shrink-0 text-destructive" width={13} height={13} aria-hidden />
      <span>This looks like it asks for a secret. What you enter goes to {card.connection}’s MCP server ({card.server}), not to GitSpace, and only a person answers it here; the agent never sees it.</span>
    </p> : null}
    {form && open ? <div className="flex flex-col gap-3">
      {Object.entries(form.properties).map(([name, field]) => <McpField key={name} name={name} field={field} required={form.required?.includes(name) ?? false} secret={card.secretLooking} value={values[name]} disabled={busy} onChange={value => change(name, value)} />)}
    </div> : null}
    {open ? null : <div className="text-caption text-foreground [overflow-wrap:anywhere]" data-mcp-elicitation-outcome>{outcome(question, card)}</div>}
    {issues.length ? <ul role="alert" className="flex list-disc flex-col gap-0.5 pl-5 text-caption text-destructive" data-mcp-elicitation-issues>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}
    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
  const actions = open ? <div className="px-4 pb-2 pt-1 sm:px-5">
    <div className="-mx-2 flex flex-wrap items-center justify-end gap-2 sm:-mx-3">
      {refuse}
      {request.mode === 'url' ? <>
        <Button variant="secondary" size="sm" asChild><a href={request.url} target="_blank" rel="noopener noreferrer">Open {card.host}<LinkExternal01 width={13} height={13} aria-hidden /></a></Button>
        <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => void send([MCP_ELICITATION_CHOICES.done], null, 'I finished')}>I finished</Button>
      </> : <Button type="submit" variant="primary" size="sm" disabled={busy}>Submit</Button>}
    </div>
  </div> : null;
  return <section aria-label={`${card.connection} asks`} data-mcp-elicitation={state} className={`relative w-full max-w-[520px] overflow-hidden border border-border bg-card ${shape.container}`}>
    <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-3.5 sm:px-5 sm:pt-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground [overflow-wrap:anywhere]"><Server01 className="shrink-0" width={12} height={12} strokeWidth={1.5} aria-hidden />{card.connection} asks</span>
        <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]" data-mcp-elicitation-source>MCP server {card.server} · tool {card.tool} · {card.workspace}</span>
      </div>
      {open ? <Badge variant="dot" color="orange">Waiting for you</Badge> : null}
    </div>
    {form && open ? <form noValidate aria-label={`Answer ${card.connection}`} onSubmit={submit}>{body}{actions}</form> : <>{body}{actions}</>}
  </section>;
}
