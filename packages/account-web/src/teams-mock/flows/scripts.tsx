// Approved scripts, drawn: the approval card (inline in the workspace transcript, as a Needs you row's dialog, and as
// the page a URL elicitation opens over MCP), what the transcript shows once the agent runs it, the library rows, a
// script's detail (versions, who approved, scope, usage) and its two flows: Revoke (a version or the whole script) and
// Edit (a new version that waits for approval while the approved one stays in use).
import { TranscriptItemView } from '../../chat/TranscriptItemView.js';
import { glyph } from '../../glyph.js';
import type { TranscriptItem } from '@gitspace/blocks';
import { badgeColors, Button, InputField, InputGroup } from '@gitspace/ui';
import { Building07, Check, Code02, FolderClosed, User01 } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { type AccountItem, principalOf } from '../data.js';
import { holdersOf } from '../model.js';
import { recordAudit } from '../settings/data.js';
import { Act, Pill, SettingRow, SettingRows } from '../settings/parts.js';
import { passkeyLabel, usePasskey } from '../settings/passkey.js';
import { useMock, useViewer } from '../viewer.js';
import { approvedScripts, machineProfiles, type ApprovedScript, type ScriptInput, type ScriptScope, type ScriptVersion } from './env-model.js';
import { ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary, TextArea, type Choice } from './kit.js';
import {
  approversFor, currentVersion, firstNames, hashOf, pendingVersion, projectLabel, promptRecipients, revokeRefusal, ruleOf, scopeLabel, scopeRoleRefusal, scriptDecisions, scriptProject,
  scopePhrase, scriptRuns, secretRefusal, secretsRefusal, undeclared, workspaceProject, type ScopeKind,
} from './scripts-rules.js';
import { deliveryLine, rolesLine } from './secret-rules.js';

const SCOPES: readonly ScopeKind[] = ['me', 'project', 'team'];
function scopeKindOf(id: string): ScopeKind { return SCOPES.find((kind) => kind === id) ?? 'project'; }
function scopeFor(kind: ScopeKind, projectId: string, userId: string): ScriptScope {
  return kind === 'me' ? { kind: 'me', userId } : kind === 'project' ? { kind: 'project', projectId } : { kind: 'team' };
}
function updateScript(id: string, change: (script: ApprovedScript) => ApprovedScript): void {
  approvedScripts.set(approvedScripts.get().map((script) => script.id === id ? change(script) : script));
}
function deliveryLabel(name: string, projectId: string): string {
  const { rule } = ruleOf(name, projectId);
  return `${rolesLine(rule, null)} · ${deliveryLine(rule.delivery)}${rule.whileHolding ? ' · while holding' : ''}`;
}
function inputLabel(input: ScriptInput): string {
  return input.kind === 'enum' ? `one of ${input.values.join(' · ')}` : `matches ${input.pattern} · e.g. ${input.example}`;
}
function profileLabel(id: string | null): string {
  const profile = machineProfiles.get().find((entry) => entry.id === id);
  return profile ? `${profile.name} (${profile.summary})` : 'Any machine';
}
/** What the redacted run prints: secret values as ***. */
function runOutput(script: ApprovedScript, version: ScriptVersion, inputs: string, machine: string): string {
  return [
    `→ ${script.name} v${version.n} #${version.hash} · ${scopeLabel(script.scope)} · the agent’s working copy on ${machine}`,
    version.secrets.length ? `→ into this process only: ${version.secrets.join(', ')}` : '→ no secrets',
    inputs ? `→ inputs: ${inputs}` : null,
    ...version.network.map((host) => `request ${host} · ${version.secrets.map((name) => `${name}=***`).join(' ') || 'ok'}`),
    script.id === 'bank-sandbox-token' ? 'wrote .tokens/openbank.json · access_token=*** expires_in=3600' : 'done',
    'exit 0',
  ].filter((line) => line !== null).join('\n');
}
function exampleInputs(version: ScriptVersion): string {
  return version.inputs.map((input) => `${input.name}=${input.kind === 'enum' ? input.values[0] ?? '' : input.example}`).join(' ');
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]"><span className="text-muted-foreground">{label}</span><div className="flex min-w-0 flex-col gap-1 text-foreground">{children}</div></div>;
}

/** What the script is: content and hash (the approval covers this content only), secrets (each with whether `viewer`
 * may use it), typed inputs, what it asks people while it runs, network, and machine profile. */
export function ScriptFacts({ script, version, viewer }: { script: ApprovedScript; version: ScriptVersion; viewer: string }) {
  const projectId = scriptProject(script);
  return <div data-script-facts="" className="flex flex-col gap-2.5">
    <Block label="Content"><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px]">{version.body}</pre><span className="font-mono text-[11px] text-muted-foreground">sha256 #{version.hash}</span></Block>
    <Block label="Secrets">{version.secrets.length ? version.secrets.map((name) => {
      const refused = secretRefusal(viewer, name, projectId);
      return <span key={name} data-script-secret={name} className="flex flex-wrap items-center gap-1.5"><span className="font-mono">{name}</span><Pill tone={refused ? 'red' : 'green'}>{refused ? `${principalOf(viewer).first} can’t use it` : `${principalOf(viewer).first} may use it`}</Pill><span className="text-[11.5px] text-muted-foreground">{deliveryLabel(name, projectId)}</span></span>;
    }) : <span className="text-muted-foreground">None</span>}</Block>
    <Block label="Inputs">{version.inputs.length ? version.inputs.map((input) => <span key={input.name}><span className="font-mono">{input.name}</span> <span className="text-muted-foreground">{inputLabel(input)}</span></span>) : <span className="text-muted-foreground">None</span>}</Block>
    <Block label="Network">{version.network.length ? <span className="font-mono">{version.network.join(' · ')}</span> : <span className="text-muted-foreground">None</span>}</Block>
    <Block label="Machine profile"><span>{profileLabel(version.profile)}</span></Block>
    <Block label="Asks while running">{version.prompts.length ? version.prompts.map((prompt) => <span key={prompt.name} data-script-prompt={prompt.name}><span className="font-mono">{prompt.name}</span> <Pill>{prompt.kind}</Pill> <span className="text-muted-foreground">{prompt.label}{prompt.choices ? ` · ${prompt.choices.join(' / ')}` : ''}{prompt.pattern ? ` · ${prompt.pattern}` : ''} · answered by {prompt.answeredBy === 'holder' ? 'the holder (a bot’s sponsor)' : 'anyone who can see the workspace, in their Needs you'}</span></span>) : <span className="text-muted-foreground">Nothing</span>}
      {version.prompts.length ? <span className="text-[11.5px] text-muted-foreground">Answers go straight into the process’s input, never into the transcript or the model.</span> : null}</Block>
    <Block label="Runs in"><span>The agent’s working copy. The approval covers this content’s hash only; anything else it calls is the agent’s code.</span></Block>
  </div>;
}

/** The approval card. `surface` says where it is drawn; `onDecided` lets a host (Needs you) clear its row. */
export function ScriptApprovalCard({ scriptId, surface, onDecided }: { scriptId: string; surface: 'transcript' | 'inbox' | 'elicitation'; onDecided?(label: string): void }) {
  const live = approvedScripts.use();
  const decisions = scriptDecisions.use();
  const { state, say } = useMock();
  const viewer = useViewer();
  const passkey = usePasskey();
  const script = live.find((entry) => entry.id === scriptId);
  const version = script ? pendingVersion(script) ?? script.versions[0] : undefined;
  const projectId = script ? scriptProject(script) : '';
  const holders = version ? holdersOf(state, version.submittedIn) : [];
  const secretBlock = version ? secretsRefusal(viewer.id, version, projectId) : null;
  const [scope, setScope] = useState<ScopeKind>(() => script?.scope.kind ?? 'project');
  const [mode, setMode] = useState<'decide' | 'decline' | 'changes'>('decide');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revokeOld, setRevokeOld] = useState(true);
  if (!script || !version) return null;
  const decision = decisions[`${script.id}@${version.n}`];
  const roleBlock = scopeRoleRefusal(viewer.id, scope, projectId, holders);
  const approvers = approversFor(scope, version, projectId, holders);
  const projectName = projectLabel(projectId);
  const choices: readonly Choice[] = [
    { id: 'me', icon: User01, title: 'For me', detail: `The holder approves; only ${holders.length ? `${firstNames(holders)}’s` : 'the holder’s'} agents run it.`, disabled: secretBlock },
    { id: 'project', icon: FolderClosed, title: `For ${projectName}`, detail: `A Lead of ${projectName} approves; every agent in ${projectName} may run it.`, disabled: secretBlock },
    { id: 'team', icon: Building07, title: 'For the team', detail: 'An Owner or Admin approves; every project’s agents may run it.', disabled: secretBlock },
  ];
  const key = `${script.id}@${version.n}`;
  const older = version.state === 'pending' ? currentVersion(script) : undefined;
  const approve = (): void => {
    const next = scopeFor(scope, projectId, viewer.id);
    const machine = principalOf(holders[0] ?? viewer.id).kind === 'bot' ? 'ec2-fleet' : version.submittedIn === 'bank-feed-sync' ? 'ledger-cloud-2' : 'crumb-cloud-1';
    const interactive = version.prompts.length > 0;
    updateScript(script.id, (entry) => ({ ...entry, scope: next,
      versions: entry.versions.map((item) => item.n === version.n ? { ...item, state: 'approved', approvedBy: viewer.id, approvedWhen: 'just now' } : older && revokeOld && item.n === older.n ? { ...item, state: 'revoked' } : item),
      runs: interactive ? entry.runs : [{ who: `agent in ${version.submittedIn}${holders.length ? ` (${firstNames(holders)})` : ''}`, workspace: version.submittedIn, when: 'just now', exit: 0, version: version.n, inputs: exampleInputs(version) }, ...entry.runs] }));
    if (interactive) scriptRuns.set([...scriptRuns.get(), { id: `run-${script.id}-${version.n}`, scriptId: script.id, version: version.n, workspaceId: version.submittedIn, step: 0, answered: [], state: 'paused' }]);
    scriptDecisions.set({ ...scriptDecisions.get(), [key]: { outcome: 'approved', by: viewer.id, note: machine, scope: next } });
    recordAudit({ actor: viewer.id, kind: 'approval', project: scope === 'team' ? undefined : projectId, text: `Approved script ${script.name} v${version.n} #${version.hash} ${scopePhrase(next)}${older ? (revokeOld ? ` · revoked v${older.n} #${older.hash}` : ` · kept v${older.n} #${older.hash} approved too`) : ''} · confirmed with ${passkeyLabel(viewer.id)}` });
    say(`Approved ${script.name} · the agent runs it by name`);
    onDecided?.(`Approved ${script.name} ${scopePhrase(next)}`);
  };
  const submitText = (): void => {
    if (!text.trim()) { setError(mode === 'decline' ? 'Say why, so the agent knows what to do instead.' : 'Say what to change; the agent revises the script and submits a new version.'); return; }
    if (mode === 'decline') {
      updateScript(script.id, (entry) => ({ ...entry, versions: entry.versions.map((item) => item.n === version.n ? { ...item, state: 'declined' } : item) }));
      recordAudit({ actor: viewer.id, kind: 'approval', project: projectId, text: `Declined script ${script.name} v${version.n}: “${text.trim()}”` });
    }
    scriptDecisions.set({ ...scriptDecisions.get(), [key]: { outcome: mode === 'decline' ? 'declined' : 'changes', by: viewer.id, note: text.trim(), scope: script.scope } });
    say(mode === 'decline' ? `Declined ${script.name} · the agent is told` : `Sent to the agent in ${version.submittedIn}`);
    onDecided?.(mode === 'decline' ? `Declined ${script.name}` : `Asked for changes to ${script.name}`);
  };
  const route = (): void => {
    const next = scopeFor(scope, projectId, holders[0] ?? viewer.id);
    updateScript(script.id, (entry) => ({ ...entry, scope: next }));
    scriptDecisions.set({ ...scriptDecisions.get(), [key]: { outcome: 'sent', by: viewer.id, note: firstNames(approvers), scope: next } });
    say(`Forwarded to ${firstNames(approvers)}`);
    onDecided?.(`Forwarded to ${firstNames(approvers)} · waits in their Needs you`);
  };

  const head = <div className="flex flex-col gap-1">
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-foreground"><Code02 width={15} height={15} strokeWidth={1.75} style={{ color: badgeColors.amber }} />
      <span className="font-mono font-semibold">{script.name}</span><Pill>v{version.n} · #{version.hash}</Pill>
      <Pill tone={version.state === 'pending' ? 'amber' : version.state === 'approved' ? 'green' : 'red'}>{version.state === 'pending' ? 'Waiting for approval' : version.state === 'approved' ? 'Approved' : version.state === 'declined' ? 'Declined' : 'Revoked'}</Pill></p>
    <p className="text-[12.5px] text-muted-foreground">{script.description} · submitted by {version.submittedBy} · {version.when}</p>
  </div>;

  let body: ReactNode;
  if (decision?.outcome === 'approved' || version.state === 'approved') {
    body = <FlowSuccess title={`Approved ${scopePhrase(script.scope)} by ${principalOf(version.approvedBy ?? viewer.id).first}`}>Agents run it by name (<span className="font-mono">gitspace script run {script.name}</span>). {version.secrets.length ? `${version.secrets.join(', ')} goes only into that process; ` : ''}output is redacted. Revoke it in Settings › Approved scripts.</FlowSuccess>;
  } else if (decision?.outcome === 'declined' || version.state === 'declined') {
    body = <p data-script-outcome="declined" className="text-caption text-muted-foreground">Declined by {principalOf(decision?.by ?? viewer.id).first}{decision ? `: “${decision.note}”` : ''}. The agent is told and works without it.</p>;
  } else if (decision?.outcome === 'changes') {
    body = <p data-script-outcome="changes" className="text-caption text-muted-foreground">{principalOf(decision.by).first} asked the agent for changes: “{decision.note}”. It submits a new version, which needs approval again.</p>;
  } else if (decision?.outcome === 'sent') {
    body = <p data-script-outcome="sent" className="text-caption text-muted-foreground">{principalOf(decision.by).first} forwarded it to {decision.note}, who can approve it {scopePhrase(decision.scope)} · it waits in their Needs you; the agent waits too.</p>;
  } else if (mode !== 'decide') {
    body = <>
      <TextArea label={mode === 'decline' ? 'Why decline?' : 'What should the agent change?'} rows={3} value={text} onChange={(value) => { setText(value); setError(null); }}
        placeholder={mode === 'decline' ? 'e.g. Use the sandbox fixture instead of a live token' : 'e.g. Write the token to the secret store, not .tokens/'} />
      {error ? <FlowError>{error}</FlowError> : null}
      <div className="-mx-1 flex flex-wrap justify-end gap-1.5"><Button variant="ghost" size="compact" onClick={() => { setMode('decide'); setError(null); }}>Back</Button><Button variant="primary" size="compact" onClick={submitText}>{mode === 'decline' ? 'Decline' : 'Send to the agent'}</Button></div>
    </>;
  } else {
    body = <>
      <ChoiceCards label="Approve for" value={scope} onChange={(id) => setScope(scopeKindOf(id))} choices={choices} />
      {secretBlock ? <FlowError>{secretBlock}. {approvers.length ? `Forward it to ${firstNames(approvers)}, who can approve it ${scope === 'project' ? `for ${projectName}` : scope === 'team' ? 'for the team' : 'for themselves'}.` : ''}</FlowError>
        : roleBlock ? <Hint>{roleBlock}. {approvers.length ? `Forward it to ${firstNames(approvers)}, who can.` : 'Nobody who may approve that scope may use every secret it needs.'}</Hint> : null}
      {older && !secretBlock && !roleBlock ? <button type="button" role="checkbox" aria-checked={revokeOld} data-revoke-old={older.n} className="flex items-center gap-2 self-start text-left text-[12.5px] text-foreground" onClick={() => setRevokeOld(!revokeOld)}>
        <span aria-hidden className={`flex size-4 shrink-0 items-center justify-center rounded ${revokeOld ? 'bg-[#6B97FF] text-white' : 'shadow-[inset_0_0_0_1.5px_var(--border)]'}`}>{revokeOld ? <Check width={12} height={12} strokeWidth={3} /> : null}</span>
        <span>Revoke version {older.n} when this is approved <span className="text-muted-foreground">· {revokeOld ? `agents run only v${version.n}` : `v${older.n} and v${version.n} both stay approved`}</span></span>
      </button> : null}
      {passkey.waiting ? <PasskeyStep userId={viewer.id} what={`approving ${script.name}`} waiting /> : null}
      <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
        <Button variant="ghost" size="compact" disabled={passkey.waiting} onClick={() => setMode('changes')}>Ask for changes</Button>
        <Button variant="secondary" size="compact" disabled={passkey.waiting} onClick={() => setMode('decline')}>Decline</Button>
        {secretBlock || roleBlock ? <Button variant="primary" size="compact" disabled={!approvers.length} onClick={route}>{approvers.length ? `Forward to ${firstNames(approvers)}` : 'No one can approve this scope'}</Button>
          : <Button variant="primary" size="compact" loading={passkey.waiting} disabled={passkey.waiting} onClick={() => passkey.confirm(approve)}>Approve with passkey</Button>}
      </div>
    </>;
  }
  return <section data-script-card={script.id} data-surface={surface} className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-3.5 py-3" style={{ boxShadow: `inset 3px 0 0 color-mix(in oklab, ${badgeColors.amber} 70%, transparent)` }}>
    {head}
    <ScriptFacts script={script} version={version} viewer={viewer.id} />
    {body}
    {surface === 'transcript' ? <p className="text-[11px] text-muted-foreground">Over MCP the same card opens as a URL elicitation: the client shows a link to {`crumbco.gitspace.sh/approve/${script.id}`}, and the approver decides in the browser with their passkey.</p> : null}
  </section>;
}

const noAnswer = async (): Promise<void> => undefined;
const at = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

/** A workspace's script submissions in its transcript: the agent's message, the card, and once approved the run by name
 * with redacted output. Shows pending versions and the ones decided this session. */
export function ScriptTranscript({ workspaceId }: { workspaceId: string }) {
  const live = approvedScripts.use();
  const decisions = scriptDecisions.use();
  const runs = scriptRuns.use();
  const { state } = useMock();
  const shown = live.flatMap((script) => script.versions.filter((version) => version.submittedIn === workspaceId && (version.state === 'pending' || decisions[`${script.id}@${version.n}`])).map((version) => ({ script, version })));
  return <>{shown.map(({ script, version }) => {
    const decision = decisions[`${script.id}@${version.n}`];
    const projectId = scriptProject(script);
    const waitingOn = approversFor(script.scope.kind, version, projectId, holdersOf(state, workspaceId));
    const said: TranscriptItem = { id: `${script.id}-${version.n}-said`, type: 'message', role: 'assistant', at: at(4),
      text: `${script.description}. I wrote \`${script.name}\` and submitted it for approval instead of running it in my shell: ${version.secrets.length ? `${version.secrets.join(', ')} would go only into its process` : 'it needs no secrets'}, with typed inputs and only ${version.network.join(', ') || 'no network'}. I’ll run it by name once it’s approved.` };
    const ran: TranscriptItem | null = decision?.outcome === 'approved' && !version.prompts.length ? { id: `${script.id}-${version.n}-run`, type: 'tool-call', toolCallId: `${script.id}-${version.n}-call`, tool: 'bash', status: 'done',
      target: `gitspace script run ${script.name} ${exampleInputs(version)}`.trim(), args: { command: `gitspace script run ${script.name} ${exampleInputs(version)}`.trim() }, startedAt: at(1), endedAt: at(0),
      result: [{ id: `${script.id}-${version.n}-out`, type: 'code', language: 'text', text: runOutput(script, version, exampleInputs(version), decision.note) }] } : null;
    const after: TranscriptItem | null = decision && decision.outcome !== 'sent' ? { id: `${script.id}-${version.n}-after`, type: 'message', role: 'assistant', at: at(0),
      text: decision.outcome === 'approved' ? (version.prompts.length ? `Approved. Running \`${script.name}\` by name; it asks ${version.prompts.map((prompt) => prompt.name).join(' and ')} as it goes.` : `It ran: exit 0. Secret values show as *** in the output.`) : decision.outcome === 'declined' ? `Understood, I won’t run it. ${principalOf(decision.by).first} said: “${decision.note}”.` : `Revising \`${script.name}\` as ${principalOf(decision.by).first} asked; the new version needs approval again.` } : null;
    return <div key={`${script.id}-${version.n}`} data-script-submission={script.id} className="flex flex-col gap-2">
      <TranscriptItemView item={said} active={false} onAnswer={noAnswer} />
      {version.state === 'pending' ? <span className="text-[11.5px] text-muted-foreground">Asked {waitingOn.length ? firstNames(waitingOn) : 'nobody yet'} · {scopePhrase(script.scope)} · in {waitingOn.length > 1 ? 'their' : 'the'} Needs you</span> : null}
      <ScriptApprovalCard scriptId={script.id} surface="transcript" />
      {ran ? <TranscriptItemView item={ran} active={false} onAnswer={noAnswer} /> : null}
      {after ? <TranscriptItemView item={after} active={false} onAnswer={noAnswer} /> : null}
    </div>;
  })}
  {runs.filter((run) => run.workspaceId === workspaceId).map((run) => <PromptRunView key={run.id} runId={run.id} />)}</>;
}

/** A run of an interactive script in the transcript: the command, its redacted output so far, the prompt card while it
 * is paused, and the run continuing to its exit once every prompt is answered. */
function PromptRunView({ runId }: { runId: string }) {
  const runs = scriptRuns.use();
  const live = approvedScripts.use();
  const run = runs.find((entry) => entry.id === runId);
  const script = live.find((entry) => entry.id === run?.scriptId);
  const version = script?.versions.find((entry) => entry.n === run?.version);
  if (!run || !script || !version) return null;
  const machine = run.workspaceId === 'bank-feed-sync' ? 'ledger-cloud-2' : run.workspaceId === 'checkout-apple-pay' ? 'ec2-fleet' : 'crumb-cloud-1';
  const next = version.prompts[run.step];
  const lines = [
    `→ ${script.name} v${version.n} #${version.hash} · ${scopeLabel(script.scope)} · the agent’s working copy on ${machine}`,
    version.secrets.length ? `→ into this process only: ${version.secrets.join(', ')}` : '→ no secrets',
    ...version.prompts.slice(0, run.step).map((prompt, index) => `→ ${prompt.name}: answered by ${principalOf(run.answered[index] ?? '').first} · not shown`),
    ...(run.state === 'paused' && next ? [`⏸ paused · waiting for ${next.name} (${next.label})`] : [
      ...version.network.map((host) => `request ${host} · ${version.secrets.map((name) => `${name}=***`).join(' ') || 'ok'}`),
      script.id === 'deploy-checkout' ? 'sst deploy · checkout-production · 14 resources updated · session token ***' : script.id === 'aws-sso-sandbox' ? 'signed in · profile sandbox · arn:aws:sts::***:assumed-role/sandbox' : 'done',
      'exit 0',
    ]),
  ];
  const call: TranscriptItem = { id: `${run.id}-call`, type: 'tool-call', toolCallId: `${run.id}-tc`, tool: 'bash', status: run.state === 'done' ? 'done' : 'running', target: `gitspace script run ${script.name}`, args: { command: `gitspace script run ${script.name}` },
    startedAt: at(2), ...(run.state === 'done' ? { endedAt: at(0) } : {}), result: [{ id: `${run.id}-out`, type: 'code', language: 'text', text: lines.join('\n') }] };
  const said: TranscriptItem = { id: `${run.id}-said`, type: 'message', role: 'assistant', at: at(3), text: `Running \`${script.name}\` by name. It asks a person for ${version.prompts.map((prompt) => prompt.name).join(' and ')}; I never see the answers.` };
  const after: TranscriptItem = { id: `${run.id}-after`, type: 'message', role: 'assistant', at: at(0), text: `\`${script.name}\` finished: exit 0. Secret values and the answers show as *** or not at all.` };
  return <div data-script-run={run.id} data-run-state={run.state} className="flex flex-col gap-2">
    <TranscriptItemView item={said} active={false} onAnswer={noAnswer} />
    <TranscriptItemView item={call} active={false} onAnswer={noAnswer} />
    {run.state === 'paused' ? <PromptCard runId={run.id} surface="transcript" /> : <TranscriptItemView item={after} active={false} onAnswer={noAnswer} />}
  </div>;
}

const LINK = { url: 'https://crumbco.awsapps.com/start/#/device', code: 'WDKX-PLQM' };

/** The card a paused run sends to whoever answers its next prompt: a code, a password, a choice, or a link (a URL and
 * a code to open; the script continues by itself once the sign-in is done). */
export function PromptCard({ runId, surface, onAnswered }: { runId: string; surface: 'transcript' | 'inbox'; onAnswered?(label: string): void }) {
  const runs = scriptRuns.use();
  const live = approvedScripts.use();
  const { state, say } = useMock();
  const viewer = useViewer();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const run = runs.find((entry) => entry.id === runId);
  const script = live.find((entry) => entry.id === run?.scriptId);
  const version = script?.versions.find((entry) => entry.n === run?.version);
  const prompt = version?.prompts[run?.step ?? 0];
  if (!run || !script || !version || !prompt || run.state !== 'paused') return null;
  const answerers = promptRecipients(run.id, (id) => holdersOf(state, id));
  const mine = answerers.includes(viewer.id);
  const answer = (): void => {
    const step = run.step + 1;
    const done = step >= version.prompts.length;
    scriptRuns.set(scriptRuns.get().map((entry) => entry.id === run.id ? { ...entry, step, answered: [...entry.answered, viewer.id], state: done ? 'done' : 'paused' } : entry));
    if (done) updateScript(script.id, (entry) => ({ ...entry, runs: [{ who: `agent in ${run.workspaceId} (${firstNames(holdersOf(state, run.workspaceId))})`, workspace: run.workspaceId, when: 'just now', exit: 0, version: version.n, inputs: version.prompts.map((item) => `${item.name} asked ${viewer.first}`).join(' · ') }, ...entry.runs] }));
    setValue(''); setOpened(false);
    say(done ? `${script.name} continues to the end` : `${script.name} continues · next it asks ${version.prompts[step]?.name ?? ''}`);
    onAnswered?.(`${prompt.name} sent to ${script.name} · not shown anywhere`);
  };
  const send = (): void => {
    if (prompt.kind === 'choice') { if (!value) { setError('Pick one.'); return; } answer(); return; }
    if (!value.trim()) { setError(`Enter the ${prompt.kind === 'password' ? 'password' : 'code'}.`); return; }
    if (prompt.pattern && !new RegExp(prompt.pattern, 'u').test(value.trim())) { setError(`That doesn’t look like ${prompt.label.toLowerCase()}: it must match ${prompt.pattern}.`); return; }
    answer();
  };
  return <section data-prompt-card={run.id} data-prompt-kind={prompt.kind} className="flex flex-col gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-3" style={{ boxShadow: `inset 3px 0 0 color-mix(in oklab, ${badgeColors.blue} 70%, transparent)` }}>
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-foreground"><Code02 width={15} height={15} strokeWidth={1.75} style={{ color: badgeColors.blue }} />
      <span className="font-mono font-semibold">{script.name}</span><span>asks: {prompt.label}</span><Pill tone="blue">{prompt.kind}</Pill><span className="text-[11.5px] text-muted-foreground">step {run.step + 1} of {version.prompts.length} · paused in {run.workspaceId}</span></p>
    <p data-prompt-recipients="" className="text-caption text-muted-foreground">{prompt.answeredBy === 'holder' ? `Went to ${firstNames(answerers) || 'nobody'}: only the holder answers.` : `Went to ${firstNames(answerers) || 'nobody'}: anyone who can see ${run.workspaceId} (${projectLabel(workspaceProject(run.workspaceId))}’s members, Owners included) may answer, in their Needs you.`}{mine ? '' : ' You can’t answer it.'}</p>
    {!mine ? null
      : prompt.kind === 'link' ? <>
        <div data-prompt-link="" className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px]"><span>Open <a className="font-mono underline" href={LINK.url} onClick={(event) => event.preventDefault()}>{LINK.url}</a></span><span>and enter <span className="font-mono text-[15px] font-semibold tracking-wider">{LINK.code}</span></span></div>
        {opened ? <p role="status" className="text-caption text-muted-foreground">Waiting for the script to continue… it does once the sign-in is done.</p> : null}
        <div className="-mx-1 flex justify-end"><Button variant="primary" size="compact" loading={opened} disabled={opened} onClick={() => { setOpened(true); window.setTimeout(answer, 1800); }}>Open sign-in page</Button></div>
      </> : <>
        {prompt.kind === 'choice' ? <ChoiceCards label={prompt.label} value={value} onChange={(id) => { setValue(id); setError(null); }} choices={(prompt.choices ?? []).map((choice) => ({ id: choice, title: choice, detail: '' }))} columns={2} />
          : <InputGroup className="w-full"><InputField index={0} label={prompt.label} type={prompt.kind === 'password' ? 'password' : 'text'} value={value} onChange={(next) => { setValue(next); setError(null); }} /></InputGroup>}
        {error ? <FlowError>{error}</FlowError> : null}
        <div className="-mx-1 flex justify-end"><Button variant="primary" size="compact" onClick={send}>Send to the script</Button></div>
      </>}
    <p className="text-[11px] text-muted-foreground">The answer goes straight into the process’s input: never into the transcript or the model.{surface === 'transcript' ? ` Over MCP this opens as a URL elicitation to GitSpace’s secure-input page (crumbco.gitspace.sh/secure-input/${run.id}).` : ''}</p>
  </section>;
}

/** A Needs you row for a script: a pending approval (Review opens the card), or a paused run's prompt (answered in place). */
export function ScriptNeedsYouRow({ item, resolve, open }: { item: AccountItem; resolve(label: string): void; open(workspaceId: string): void }) {
  if (item.run) return <section data-column-card={item.id} data-account-item={item.id} className="flex min-w-0 flex-col gap-2"><PromptCard runId={item.run} surface="inbox" onAnswered={resolve} /></section>;
  return <ApprovalNeedsYouRow item={item} resolve={resolve} open={open} />;
}

function ApprovalNeedsYouRow({ item, resolve, open }: { item: AccountItem; resolve(label: string): void; open(workspaceId: string): void }) {
  const live = approvedScripts.use();
  const [reviewing, setReviewing] = useState(false);
  const script = live.find((entry) => entry.id === item.script);
  const version = script ? pendingVersion(script) : undefined;
  if (!script || !version) return null;
  return <section data-column-card={item.id} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card px-3 py-2.5" style={{ boxShadow: `inset 3px 0 0 color-mix(in oklab, ${badgeColors.amber} 70%, transparent)` }}>
    <div className="flex min-w-0 items-start gap-2.5" data-account-item={item.id}>
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full" style={{ color: badgeColors.amber, background: `color-mix(in oklab, ${badgeColors.amber} 14%, transparent)` }}><Code02 width={13} height={13} strokeWidth={1.75} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline justify-between gap-2"><span className="truncate text-[13.5px] font-medium text-foreground">Approve script <span className="font-mono">{script.name}</span>{version.n > 1 ? ` v${version.n}` : ''}</span><span className="shrink-0 text-[12px] text-muted-foreground">{version.when}</span></span>
        <span className="text-[12px] leading-snug text-muted-foreground"><span className="text-foreground/80">{projectLabel(scriptProject(script))} · {scopePhrase(script.scope)}</span> · {script.description}. Submitted by {version.submittedBy}.</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">#{version.hash}{version.secrets.length ? ` · secrets ${version.secrets.join(', ')}` : ''}{version.network.length ? ` · ${version.network.join(', ')}` : ''}</span>
      </div>
    </div>
    <div className="-mx-1 flex flex-wrap items-center justify-end gap-1.5">
      <Button variant="ghost" size="compact" onClick={() => open(version.submittedIn)}>Open workspace</Button>
      <Button variant="primary" size="compact" onClick={() => setReviewing(true)}>Review</Button>
    </div>
    {reviewing ? <FlowDialog id="script-review" title={`Approve ${script.name}?`} description="The same card the agent’s transcript shows; over MCP it opens as a URL elicitation." onClose={() => setReviewing(false)}>
      <ScriptApprovalCard scriptId={script.id} surface="inbox" onDecided={(label) => { setReviewing(false); resolve(label); }} />
    </FlowDialog> : null}
  </section>;
}

/** Library rows: each script with its scope, current version, who approved it, a pending version, the last run. */
export function ScriptRows({ scripts, label }: { scripts: readonly ApprovedScript[]; label: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return <>
    <SettingRows label={label}>{scripts.map((script) => {
      const current = currentVersion(script);
      const pending = pendingVersion(script);
      const last = script.runs[0];
      return <SettingRow key={script.id} media={glyph(Code02)}
        title={<span data-script-row={script.id} className="inline-flex flex-wrap items-center gap-2"><span className="font-mono">{script.name}</span><Pill tone={script.scope.kind === 'team' ? 'gray' : script.scope.kind === 'project' ? 'teal' : 'violet'}>{scopeLabel(script.scope)}</Pill>{pending ? <Pill tone="amber">v{pending.n} waiting for approval</Pill> : null}{!current && !pending ? <Pill tone="red">Not approved</Pill> : null}</span>}
        description={<>{script.description}<br />{current ? `v${current.n} #${current.hash} · approved by ${principalOf(current.approvedBy ?? '').first} ${current.approvedWhen ?? ''}` : 'No approved version'}{last ? ` · last run ${last.when}, exit ${last.exit}` : ' · never run'}</>}>
        <Button variant="secondary" size="compact" onClick={() => setOpen(script.id)}>Open</Button>
      </SettingRow>;
    })}</SettingRows>
    {open ? <ScriptDetailDialog scriptId={open} onClose={() => setOpen(null)} /> : null}
  </>;
}

function stateTone(state: ScriptVersion['state']): 'green' | 'amber' | 'red' | 'gray' { return state === 'approved' ? 'green' : state === 'pending' ? 'amber' : state === 'revoked' ? 'red' : 'gray'; }

/** A script's detail: scope, versions (each with who approved it), usage history, Edit and Revoke. */
export function ScriptDetailDialog({ scriptId, onClose }: { scriptId: string; onClose(): void }) {
  const live = approvedScripts.use();
  const viewer = useViewer();
  const [flow, setFlow] = useState<'revoke' | 'edit' | 'review' | null>(null);
  const script = live.find((entry) => entry.id === scriptId);
  if (!script) return null;
  const current = currentVersion(script);
  const pending = pendingVersion(script);
  const editRefusal = script.scope.kind === 'me' && script.scope.userId !== viewer.id ? `Only ${principalOf(script.scope.userId).first} edits their own script` : null;
  const revoke = current ? revokeRefusal(viewer.id, script) : 'No approved version to revoke';
  if (flow === 'revoke') return <RevokeDialog script={script} onClose={() => setFlow(null)} />;
  if (flow === 'edit') return <EditScriptDialog script={script} onClose={() => setFlow(null)} />;
  if (flow === 'review') return <FlowDialog id="script-review" title={`Approve ${script.name}?`} onClose={() => setFlow(null)}><ScriptApprovalCard scriptId={script.id} surface="inbox" onDecided={() => setFlow(null)} /></FlowDialog>;
  return <FlowDialog id="script-detail" title={<span className="font-mono">{script.name}</span>} description={script.description} onClose={onClose}
    footer={<>
      <Button variant="ghost" onClick={onClose}>Close</Button>
      <Act reason={editRefusal} variant="secondary" onClick={() => setFlow('edit')}>Edit</Act>
      <Act reason={revoke} variant="secondary" onClick={() => setFlow('revoke')}>Revoke</Act>
      {pending ? <Button variant="primary" onClick={() => setFlow('review')}>Review v{pending.n}</Button> : null}
    </>}>
    <Summary rows={[
      ['Scope', `${scopeLabel(script.scope)}${script.scope.kind === 'me' ? ' · only their agents run it' : ''} · runs in the agent’s working copy`],
      ['In use', current ? `v${current.n} #${current.hash} · approved by ${principalOf(current.approvedBy ?? '').name} ${current.approvedWhen ?? ''}` : 'No approved version'],
      ['Waiting', pending ? `v${pending.n} #${pending.hash} · submitted by ${pending.submittedBy} ${pending.when}${current ? `; v${current.n} stays in use until revoked` : ''}` : 'Nothing'],
      ['Agents run it', <span key="run" className="font-mono text-[12px]">gitspace script run {script.name}</span>],
    ]} />
    <div data-script-versions="" className="flex flex-col gap-2">
      <span className="text-caption font-medium text-foreground">Versions</span>
      {script.versions.map((version) => <div key={version.n} data-script-version={version.n} className="flex flex-col gap-1 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="flex flex-wrap items-center gap-2 text-[12.5px]"><span className="font-medium">v{version.n}</span><span className="font-mono text-muted-foreground">#{version.hash}</span>
          <Pill tone={stateTone(version.state)}>{version.state === 'approved' ? (version === current ? 'In use' : 'Approved · kept until revoked') : version.state === 'pending' ? 'Waiting for approval' : version.state === 'revoked' ? 'Revoked' : 'Declined'}</Pill>
          </span>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[8px] bg-surface-2 px-2 py-1 font-mono text-[11px]">{version.body}</pre>
        <span className="text-[11.5px] text-muted-foreground">Submitted by {version.submittedBy} · {version.when}{version.approvedBy ? ` · approved by ${principalOf(version.approvedBy).first} ${version.approvedWhen ?? ''}` : ''} · secrets {version.secrets.join(', ') || 'none'} · inputs {version.inputs.map((input) => input.name).join(', ') || 'none'} · asks {version.prompts.map((prompt) => prompt.name).join(', ') || 'nothing'} · network {version.network.join(', ') || 'none'}</span>
      </div>)}
    </div>
    <div data-script-runs="" className="flex flex-col gap-1">
      <span className="text-caption font-medium text-foreground">Usage</span>
      {script.runs.length ? <table className="w-full text-left text-[12px]"><thead className="text-muted-foreground"><tr><th className="py-1 font-normal">Who</th><th className="font-normal">When</th><th className="font-normal">Version</th><th className="font-normal">Inputs</th><th className="font-normal">Exit</th></tr></thead>
        <tbody>{script.runs.map((run, index) => <tr key={`${run.when}-${index}`} className="border-t border-border"><td className="py-1 pr-2">{run.who}</td><td className="pr-2">{run.when}</td><td className="pr-2">v{run.version}</td><td className="pr-2 font-mono">{run.inputs || '—'}</td><td><Pill tone={run.exit === 0 ? 'green' : 'red'}>{run.exit}</Pill></td></tr>)}</tbody></table>
        : <Hint>Never run.</Hint>}
    </div>
  </FlowDialog>;
}

/** Revoke a version (the older approved one, say, once the new one is in use) or the whole script. */
function RevokeDialog({ script, onClose }: { script: ApprovedScript; onClose(): void }) {
  const viewer = useViewer();
  const passkey = usePasskey();
  const approved = script.versions.filter((version) => version.state === 'approved');
  const [what, setWhat] = useState<string>(approved.length > 1 ? String(approved.at(-1)?.n ?? 'all') : 'all');
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const all = what === 'all';
  const choices: readonly Choice[] = [
    ...approved.map((version) => ({ id: String(version.n), title: `Version ${version.n} only · #${version.hash}`,
      detail: approved.length > 1 ? `Agents use ${approved.find((other) => other.n !== version.n) ? `v${approved.find((other) => other.n !== version.n)?.n}` : 'the other version'} from now on.` : 'It is the only approved version: agents can’t run the script until a new version is approved.' })),
    { id: 'all', title: 'The whole script', detail: 'Every version stops working now, a pending one too. Agents that ask for it are told it was revoked and by whom.' },
  ];
  const finish = (): void => {
    approvedScripts.set(approvedScripts.get().map((entry) => entry.id !== script.id ? entry : { ...entry,
      versions: entry.versions.map((version) => all ? (version.state === 'approved' ? { ...version, state: 'revoked' } : version.state === 'pending' ? { ...version, state: 'declined' } : version) : String(version.n) === what ? { ...version, state: 'revoked' } : version) }));
    recordAudit({ actor: viewer.id, kind: 'approval', project: script.scope.kind === 'project' ? script.scope.projectId : undefined, text: `Revoked ${all ? 'script' : `v${what} of`} ${script.name} · confirmed with ${passkeyLabel(viewer.id)}` });
    setDone(true);
  };
  const next = (): void => {
    if (step === 0) { setStep(1); return; }
    if (typed.trim() !== script.name) { setError(`Type ${script.name} exactly to confirm; you typed “${typed.trim() || 'nothing'}”.`); return; }
    passkey.confirm(finish);
  };
  return <FlowDialog id="script-revoke" title={`Revoke ${script.name}`} steps={['What', 'Confirm']} step={step} done={done} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setStep(0); setError(null); }} onCancel={onClose} next={next} nextLabel={step === 0 ? 'Continue' : 'Revoke with passkey'} busy={passkey.waiting} />}>
    {done ? <FlowSuccess title={all ? `${script.name} is revoked` : `v${what} of ${script.name} is revoked`}>{all ? 'Agents can’t run it; it stays in the library, revoked, with its history.' : 'The other approved version stays in use.'} Recorded in the audit log.</FlowSuccess>
      : step === 0 ? <ChoiceCards label="Revoke" value={what} onChange={setWhat} choices={choices} />
      : <>
        <Summary rows={[['Revoking', all ? 'Every version' : `v${what}`], ['Scope', scopeLabel(script.scope)], ['Runs so far', String(script.runs.length)]]} />
        <TextArea label={`Type ${script.name} to confirm`} rows={1} mono value={typed} onChange={(value) => { setTyped(value); setError(null); }} />
        {error ? <FlowError>{error}</FlowError> : null}
        {passkey.waiting ? <PasskeyStep userId={viewer.id} what="revoking" waiting /> : null}
      </>}
  </FlowDialog>;
}

/** Edit: the content changes, so the hash does; the new version waits for approval and the approved one stays in use.
 * Editing while a version is pending replaces that pending version (same number, new hash); it isn't kept. */
function EditScriptDialog({ script, onClose }: { script: ApprovedScript; onClose(): void }) {
  const viewer = useViewer();
  const { state } = useMock();
  const [replaced] = useState(() => pendingVersion(script));
  const [current] = useState(() => currentVersion(script));
  const [n] = useState(() => replaced?.n ?? Math.max(...script.versions.map((entry) => entry.n)) + 1);
  const base = replaced ?? current ?? script.versions[0];
  const [step, setStep] = useState(0);
  const [body, setBody] = useState(base?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!base) return null;
  const hash = hashOf(body);
  const projectId = scriptProject(script);
  const approvers = approversFor(script.scope.kind, base, projectId, holdersOf(state, base.submittedIn));
  const meanwhile = current ? `v${current.n} stays in use` : 'Nothing approved runs';
  const next = (): void => {
    if (step === 0) {
      if (body.trim() === base.body.trim()) { setError('Nothing changed: the content is the same as v' + String(base.n) + '.'); return; }
      const extra = undeclared(body, base);
      if (extra.length) { setError(`The script reads ${extra.map((name) => `$${name}`).join(', ')}, which ${extra.length > 1 ? 'aren’t' : 'isn’t'} among its secrets or typed inputs. Scripts get only what they declare; an agent submits a script that declares it.`); return; }
      setStep(1); return;
    }
    const version: ScriptVersion = { ...base, n, hash, body: body.trim(), submittedBy: `${viewer.first} (edited in Settings)`, when: 'just now', state: 'pending', approvedBy: null, approvedWhen: null };
    approvedScripts.set(approvedScripts.get().map((entry) => entry.id === script.id ? { ...entry, versions: [version, ...entry.versions.filter((item) => item.n !== replaced?.n)] } : entry));
    if (replaced) scriptDecisions.set(Object.fromEntries(Object.entries(scriptDecisions.get()).filter(([key]) => key !== `${script.id}@${replaced.n}`)));
    recordAudit({ actor: viewer.id, kind: 'setting', project: script.scope.kind === 'project' ? script.scope.projectId : undefined, text: replaced ? `Replaced pending v${n} #${replaced.hash} of ${script.name} with #${hash}, submitted for approval` : `Submitted v${n} #${hash} of ${script.name} for approval` });
    setDone(true);
  };
  return <FlowDialog id="script-edit" title={`Edit ${script.name}`} steps={['Content', 'Review']} step={step} done={done} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => setStep(0)} onCancel={onClose} next={next} nextLabel={step === 0 ? 'Review' : 'Submit for approval'} />}>
    {done ? <FlowSuccess title={`v${n} #${hash} is waiting for approval`}>It waits in {firstNames(approvers) || 'the approvers’'} Needs you{replaced ? `, in place of #${replaced.hash}` : ''}. {current ? `v${current.n} stays in use until the new one is approved.` : 'Agents can run it once it is approved.'}</FlowSuccess>
      : step === 0 ? <>
        {replaced ? <Hint>v{replaced.n} #{replaced.hash} is waiting for approval. Submitting replaces it: approvers see only the new content, and #{replaced.hash} can’t be approved any more.</Hint> : null}
        <TextArea label="Content" mono rows={5} value={body} onChange={(value) => { setBody(value); setError(null); }} />
        <Hint>Secrets ({base.secrets.join(', ') || 'none'}) and typed inputs ({base.inputs.map((input) => input.name).join(', ') || 'none'}) stay as they are. New hash: #{hash}.</Hint>
        {error ? <FlowError>{error}</FlowError> : null}
      </> : <>
        <Summary rows={replaced
          ? [['Replaces', `v${replaced.n} #${replaced.hash} · waiting for approval · submitted by ${replaced.submittedBy}`], ['Becomes', `v${n} #${hash} · waiting for approval in its place`], ['Approved by', `${firstNames(approvers) || 'nobody who may'} · ${scopePhrase(script.scope)}`], ['Meanwhile', meanwhile]]
          : [['Was', `v${base.n} #${base.hash}`], ['Becomes', `v${n} #${hash} · waiting for approval`], ['Approved by', `${firstNames(approvers) || 'nobody who may'} · ${scopePhrase(script.scope)}`], ['Meanwhile', meanwhile]]} />
        <pre data-script-diff="" className="overflow-x-auto whitespace-pre-wrap break-all rounded-[10px] bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px]">
          {base.body.split('\n').map((line) => <span key={`-${line}`} className="block text-destructive">- {line}</span>)}
          {body.trim().split('\n').map((line) => <span key={`+${line}`} className="block text-[#067647]">+ {line}</span>)}
        </pre>
      </>}
  </FlowDialog>;
}
