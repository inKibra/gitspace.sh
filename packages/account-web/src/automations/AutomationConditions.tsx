import { Button, Select, SelectTrigger, useShape } from '@gitspace/ui';
import { Trash01, XCircle } from '@untitledui/icons';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { type AutomationCondition } from '@gitspace/protocol/automations-contract';
import { options } from './automation-fields.js';
import { CONDITION_LABEL, DRAFT_RULES, LINKED_RULES, LIST_MODES, LIST_RULE, PRERELEASE_RULES, PULL_REQUEST_RULES, VALUE_PLACEHOLDER, VALUE_SUGGESTIONS, type ValuesConditionKind } from './automation-formatters.js';

export function Code({ children }: { children: ReactNode }): ReactElement {
  return <code className="font-mono text-caption">{children}</code>;
}

/** `opened`, `ready_for_review` or `closed`: code-styled values with `last` before the final one. */
export function CodeList({ values, last }: { values: readonly string[]; last: string }): ReactElement {
  return <>{values.map((value, index) => <span key={value}>{index === 0 ? '' : index === values.length - 1 ? last : ', '}<Code>{value}</Code></span>)}</>;
}

/** A card's Only if, one phrase per condition. */
export function ConditionReadback({ condition, bot }: { condition: AutomationCondition; bot: string }): ReactNode {
  switch (condition.kind) {
    case 'linked': return condition.linked ? 'it is linked' : 'it has no linked workspace';
    case 'mentionsBot': return <>mentions <Code>{bot}</Code></>;
    case 'draft': return condition.draft ? 'a draft' : 'not a draft';
    case 'pullRequest': return condition.pullRequest ? 'on a pull request' : 'on an issue';
    case 'conclusion': return <>conclusion is <CodeList values={condition.values} last=" or " /></>;
    case 'reviewState': return <>review is <CodeList values={condition.values} last=" or " /></>;
    case 'labels': return <>{condition.mode === 'oneOf' ? 'labeled' : 'no label'} <CodeList values={condition.values} last=" or " /></>;
    case 'changedFiles': return <>{condition.mode === 'oneOf' ? 'changed files match' : 'no changed file matches'} <CodeList values={condition.values} last=" or " /></>;
    case 'baseBranch': return <>base branch is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'headBranch': return <>head branch is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'branch': return <>branch is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'author': return <>author is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'tag': return <>tag is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'prerelease': return condition.prerelease ? 'a prerelease' : 'not a prerelease';
    case 'environment': return <>environment is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'deploymentState': return <>state is <CodeList values={condition.values} last=" or " /></>;
  }
}

function RuleSelect({ label, value, choices, onChange }: { label: string; value: string; choices: readonly { value: string; label: string }[]; onChange(value: string): void }): ReactElement {
  return <div className="w-44 max-w-full"><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} />{options(choices)}</Select></div>;
}

function ConditionRule({ condition, bot, onChange }: { condition: AutomationCondition; bot: string; onChange(condition: AutomationCondition): void }): ReactElement {
  const label = `${CONDITION_LABEL[condition.kind]} rule`;
  switch (condition.kind) {
    case 'linked': return <RuleSelect label={label} value={condition.linked ? 'linked' : 'unlinked'} choices={LINKED_RULES} onChange={value => onChange({ kind: 'linked', linked: value === 'linked' })} />;
    case 'draft': return <RuleSelect label={label} value={condition.draft ? 'draft' : 'ready'} choices={DRAFT_RULES} onChange={value => onChange({ kind: 'draft', draft: value === 'draft' })} />;
    case 'pullRequest': return <RuleSelect label={label} value={condition.pullRequest ? 'pullRequest' : 'issue'} choices={PULL_REQUEST_RULES} onChange={value => onChange({ kind: 'pullRequest', pullRequest: value === 'pullRequest' })} />;
    case 'prerelease': return <RuleSelect label={label} value={condition.prerelease ? 'prerelease' : 'stable'} choices={PRERELEASE_RULES} onChange={value => onChange({ kind: 'prerelease', prerelease: value === 'prerelease' })} />;
    case 'mentionsBot': return <span className="pt-1.5 text-body text-muted-foreground [overflow-wrap:anywhere]">Mentions {bot}</span>;
    case 'conclusion':
    case 'reviewState':
    case 'deploymentState': return <span className="pt-1.5 text-body text-muted-foreground">is one of</span>;
    default: return <RuleSelect label={label} value={condition.mode} choices={LIST_MODES.map(mode => ({ value: mode, label: LIST_RULE[condition.kind][mode] }))}
      onChange={value => { const mode = LIST_MODES.find(entry => entry === value); if (mode) onChange({ ...condition, mode }); }} />;
  }
}

function ChipsInput({ kind, values, invalid, onChange }: { kind: ValuesConditionKind; values: readonly string[]; invalid: boolean; onChange(values: string[]): void }): ReactElement {
  const shape = useShape();
  const listId = useId();
  const [draft, setDraft] = useState('');
  const suggestions = (VALUE_SUGGESTIONS[kind] ?? []).filter(value => !values.includes(value));
  const add = (): void => {
    const value = draft.trim();
    if (value && !values.includes(value)) onChange([...values, value]);
    setDraft('');
  };
  return <div className={`${shape.input} flex w-full min-w-0 flex-wrap items-center gap-1 border bg-background px-1.5 py-1 ${invalid ? 'border-destructive' : 'border-border'}`}>
    {values.map(value => <span key={value} className="flex min-w-0 max-w-full items-center gap-0.5 rounded bg-surface-2 py-0.5 pl-1.5 pr-0.5 font-mono text-caption [overflow-wrap:anywhere]">
      {value}
      <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter(entry => entry !== value))}><XCircle width={12} height={12} strokeWidth={1.5} /></button>
    </span>)}
    <input list={suggestions.length ? listId : undefined} value={draft} placeholder={values.length ? 'Add…' : VALUE_PLACEHOLDER[kind]} aria-label={`Add to ${CONDITION_LABEL[kind]}`} aria-invalid={invalid || undefined}
      onChange={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} onBlur={add}
      className="min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 font-mono text-caption text-foreground outline-none" />
    {suggestions.length ? <datalist id={listId}>{suggestions.map(value => <option key={value} value={value} />)}</datalist> : null}
  </div>;
}

export function ConditionRow({ condition, bot, missing, onChange, onRemove }: { condition: AutomationCondition; bot: string; missing: boolean; onChange(condition: AutomationCondition): void; onRemove(): void }): ReactElement {
  const label = CONDITION_LABEL[condition.kind];
  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1.5 py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]">
    <span className="pt-1.5 text-caption font-medium text-muted-foreground">{label}</span>
    <div className="col-span-2 row-start-2 flex min-w-0 flex-col items-stretch gap-2 sm:col-span-1 sm:col-start-2 sm:row-start-1">
      <ConditionRule condition={condition} bot={bot} onChange={onChange} />
      {'values' in condition ? <ChipsInput kind={condition.kind} values={condition.values} invalid={missing} onChange={values => onChange({ ...condition, values })} /> : null}
      {missing ? <p role="alert" className="text-caption text-destructive">Add at least one value, or remove this filter.</p> : null}
    </div>
    <Button variant="ghost" size="icon" type="button" className="col-start-2 row-start-1 sm:col-start-3" aria-label={`Remove the ${label} filter`} onClick={onRemove}><Trash01 width={14} height={14} strokeWidth={1.5} /></Button>
  </li>;
}
