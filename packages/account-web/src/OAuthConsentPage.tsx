import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, CheckboxGroup, CheckboxItem, InputField, InputGroup, RadioGroup, RadioItem } from '@gitspace/ui';
import { STEP_UP_HEADER, type DeviceCapability, type DeviceScope } from '@gitspace/protocol/device-grant';
import {
  MCP_OAUTH_CONSENT_API, MCP_OAUTH_STEP_UP_CAPABILITIES, mcpOAuthConsentDecisionResultSchema, mcpOAuthConsentViewResultSchema,
  type McpOAuthConsentDecision, type McpOAuthConsentView,
} from '@gitspace/protocol/mcp-authorization';
import type { z } from 'zod';
import { API_CLIENT_CAPABILITIES, API_CLIENT_TTLS } from './api-client-options.js';
import { createDeviceSignedFetch, DeviceRejectedError, loadDevice, prepareApiClientInvite } from './device.js';
import type { StepUp } from './passkeys.js';
import { StepUpPrompt, stepUpErrorMessage, TAP, useStepUp } from './StepUpPrompt.js';

const signedFetch = createDeviceSignedFetch(loadDevice, code => { throw new DeviceRejectedError(code); });

/** A refusal from the consent API, with the account's error code (`STEP_UP_*` when the step-up was refused). */
class ConsentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

/** Posts to the consent API (`MCP_OAUTH_CONSENT_API`), signed by this browser, with `headers` (the step-up, when one is
 * due), and reads its value or the error it gave. */
async function consentRequest<T>(operation: 'view' | 'decide', body: object, schema: z.ZodType<{ status: 'ok'; value: T } | { status: 'error'; error: { code: string; message: string } }>, headers: Readonly<Record<string, string>> = {}): Promise<T> {
  const response = await signedFetch(`${MCP_OAUTH_CONSENT_API}/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const answer = schema.safeParse(await response.json().catch(() => null));
  if (!answer.success) throw new Error(`GitSpace could not read this request (HTTP ${response.status}).`);
  if (answer.data.status === 'error') throw new ConsentError(answer.data.error.code, answer.data.error.message);
  return answer.data.value;
}

/** The account's projects as the page lists and creates them. */
export interface OAuthConsentProjects {
  list(): Promise<ReadonlyArray<{ id: string; name: string }>>;
  create(name: string): Promise<{ id: string; name: string }>;
}

/**
 * The OAuth consent page (`/oauth/consent?request=<id>`) on a signed-in GitSpace browser: who asks (the app's name, logo
 * and host from its metadata document, or marked unverified when it registered itself) and, prominently, the host its
 * answer goes to; the permissions as checkboxes, the app's requested ones ticked; the whole account, or one or more
 * projects, including a new one made here; the lifetime; Allow and Deny. Allow signs a client invitation with this
 * browser's key for exactly that choice. Powerful permissions (`MCP_OAUTH_STEP_UP_CAPABILITIES`) take an
 * `mcp-oauth.grant` step-up, prefetched while they are ticked so Allow runs the passkey straight away; with no passkey
 * enrolled, the recovery key answers it.
 */
export function OAuthConsentPage({ requestId, projects }: { requestId: string; projects: OAuthConsentProjects }) {
  const [view, setView] = useState<McpOAuthConsentView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ReadonlyArray<{ id: string; name: string }> | null>(null);
  const [capabilities, setCapabilities] = useState<readonly DeviceCapability[]>([]);
  const [wholeAccount, setWholeAccount] = useState(true);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [newProject, setNewProject] = useState('');
  const [ttl, setTtl] = useState('30d');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leavingFor, setLeavingFor] = useState<string | null>(null);
  // A recovery-key proof answers the one challenge it signed: a renewed challenge needs a new one.
  const [recovery, setRecovery] = useState<{ stepUp: StepUp; proof: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const device = await loadDevice();
        if (!device) throw new Error('This browser is not signed in to GitSpace.');
        const loaded = await consentRequest('view', { userId: device.userId, requestId }, mcpOAuthConsentViewResultSchema);
        if (!live) return;
        setView(loaded);
        setCapabilities(loaded.requestedCapabilities);
      } catch (failure) {
        if (live) setLoadError(failure instanceof Error ? failure.message : 'GitSpace could not load this request.');
      }
    })();
    projects.list().then(listed => { if (live) setExisting(listed); }, () => { if (live) setExisting([]); });
    return () => { live = false; };
  }, [requestId]);
  const powerful = capabilities.some(capability => MCP_OAUTH_STEP_UP_CAPABILITIES[capability]);
  const confirming = useStepUp(view && powerful ? { purpose: 'mcp-oauth.grant', targets: [requestId] } : null);
  const challenge = confirming.value;
  const recovered = recovery && recovery.stepUp === challenge ? recovery : null;
  const name = newProject.trim();
  const canAllow = view !== null && capabilities.length > 0 && (wholeAccount || chosen.length > 0 || name !== '')
    && (!powerful || (challenge !== null && (recovered !== null || challenge.passkeyAvailable)));

  async function decide(allow: boolean) {
    if (!view || busy) return;
    // The passkey runs first in the click: Safari runs WebAuthn only inside a gesture.
    const proof = allow && powerful && challenge ? (recovered ? Promise.resolve(recovered.proof) : challenge.withPasskey()) : Promise.resolve(null);
    setBusy(true);
    setError(null);
    try {
      const device = await loadDevice();
      if (!device) throw new Error('This browser is not signed in to GitSpace.');
      let decision: McpOAuthConsentDecision = { userId: device.userId, requestId, decision: 'deny' };
      const header = await proof;
      if (allow) {
        const created = !wholeAccount && name !== '' ? await projects.create(name) : null;
        if (created) {
          setExisting(current => [...(current ?? []), created]);
          setChosen(current => [...current, created.id]);
          setNewProject('');
        }
        const projectIds = created ? [...chosen, created.id] : [...chosen];
        const [only] = projectIds;
        const scope: DeviceScope = wholeAccount ? { kind: 'user' } : only !== undefined && projectIds.length === 1 ? { kind: 'project', projectId: only } : { kind: 'projects', projectIds };
        const invite = await prepareApiClientInvite(device, { label: view.client.name, scope, capabilities: [...capabilities], ttlMs: API_CLIENT_TTLS.find(option => option.value === ttl)?.ms ?? null });
        decision = { userId: device.userId, requestId, decision: 'allow', invite };
      }
      const { redirectUrl } = await consentRequest('decide', decision, mcpOAuthConsentDecisionResultSchema, header ? { [STEP_UP_HEADER]: header } : {});
      setLeavingFor(new URL(redirectUrl).host);
      window.location.assign(redirectUrl);
    } catch (failure) {
      setError(stepUpErrorMessage(failure, 'GitSpace could not answer this request.'));
      if (allow && powerful) { setRecovery(null); confirming.renew(); }
    } finally {
      setBusy(false);
    }
  }

  return <main className="flex min-h-dvh justify-center bg-background p-4 text-foreground antialiased sm:items-center sm:p-6">
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>{view ? `Allow ${view.client.name} to use your GitSpace?` : 'Connect an app to GitSpace'}</CardTitle>
        <CardDescription>An app asks to use your GitSpace account through MCP. It gets only what you allow here, and you can revoke it in Settings → Connections → MCP.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {loadError ? <p role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">{loadError}</p>
          : view === null ? <p role="status" className="text-body text-muted-foreground">Loading the request…</p>
            : leavingFor ? <p role="status" className="text-body text-foreground">Returning to <span className="font-mono">{leavingFor}</span>…</p>
              : <>
                <section aria-label="Who is asking" className="flex items-start gap-3">
                  {view.client.logoUri ? <img src={view.client.logoUri} alt="" referrerPolicy="no-referrer" className="size-12 shrink-0 rounded-lg object-contain" /> : null}
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="text-[20px] font-semibold leading-snug [overflow-wrap:anywhere]" data-oauth-client-name>{view.client.name}</p>
                    {view.client.registration === 'metadata-document'
                      ? <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">Identified by its metadata document on <span className="font-mono text-foreground" data-oauth-client-host>{view.client.host}</span></p>
                      : <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground [overflow-wrap:anywhere]" data-oauth-unverified><Badge color="amber">Unverified</Badge>This app registered itself: nothing confirms its name{view.client.host ? ` or that it belongs to ${view.client.host}` : ''}.</p>}
                  </div>
                </section>
                <section aria-label="Where you return" className="flex flex-col gap-1">
                  <span className="text-caption text-muted-foreground">Your answer, and the access you allow, go to</span>
                  <p className="break-all font-mono text-[20px] font-semibold leading-snug" data-oauth-redirect-host>{view.redirectHost}</p>
                  {view.loopback ? <p role="note" className="text-caption text-foreground [text-wrap:pretty]">That address is this computer. Any program running on it could receive this access: allow only if you started this connection yourself just now.</p> : null}
                </section>
                <section aria-label="Permissions" className="flex flex-col gap-3">
                  <h2 className="text-body font-semibold">Permissions</h2>
                  {API_CLIENT_CAPABILITIES.map(capability => <div key={capability.id} className="flex flex-col gap-0.5">
                    <CheckboxGroup checkedIndices={new Set(capabilities.includes(capability.id) ? [0] : [])}>
                      <CheckboxItem index={0} label={capability.label} checked={capabilities.includes(capability.id)} data-capability={capability.id}
                        onToggle={() => { if (!busy) setCapabilities(current => current.includes(capability.id) ? current.filter(value => value !== capability.id) : [...current, capability.id]); }} />
                    </CheckboxGroup>
                    <p className="pl-7 text-caption text-muted-foreground [text-wrap:pretty]">{capability.description}{MCP_OAUTH_STEP_UP_CAPABILITIES[capability.id] ? '. Needs your passkey.' : ''}</p>
                  </div>)}
                </section>
                <section aria-label="Projects" className="flex flex-col gap-3">
                  <h2 className="text-body font-semibold">Projects</h2>
                  <RadioGroup value={wholeAccount ? 'account' : 'projects'} onValueChange={value => { if (!busy) setWholeAccount(value === 'account'); }} aria-label="Projects">
                    <RadioItem index={0} value="account" label="Whole account" />
                    <RadioItem index={1} value="projects" label="Only the projects I choose" />
                  </RadioGroup>
                  {wholeAccount ? null : <div className="flex flex-col gap-3 pl-7">
                    {existing === null ? <p role="status" className="text-caption text-muted-foreground">Loading projects…</p>
                      : existing.length === 0 ? <p className="text-caption text-muted-foreground">No projects yet: name a new one below.</p>
                        : <CheckboxGroup checkedIndices={new Set(existing.flatMap((project, index) => chosen.includes(project.id) ? [index] : []))} aria-label="Projects to allow">
                          {existing.map((project, index) => <CheckboxItem key={project.id} index={index} label={project.name} checked={chosen.includes(project.id)}
                            onToggle={() => { if (!busy) setChosen(current => current.includes(project.id) ? current.filter(id => id !== project.id) : [...current, project.id]); }} />)}
                        </CheckboxGroup>}
                    <InputGroup className="w-full"><InputField index={0} label="New project for this app (optional)" value={newProject} onChange={setNewProject} placeholder="Project name" maxLength={80} disabled={busy} /></InputGroup>
                  </div>}
                </section>
                <section aria-label="Lifetime" className="flex flex-col gap-3">
                  <h2 className="text-body font-semibold">Lifetime</h2>
                  <RadioGroup value={ttl} onValueChange={value => { if (!busy) setTtl(value); }} aria-label="Lifetime">
                    {API_CLIENT_TTLS.map((option, index) => <RadioItem key={option.value} index={index} value={option.value} label={option.label} />)}
                  </RadioGroup>
                </section>
                {powerful ? <section aria-label="Confirm" className="flex flex-col gap-3">
                  <p className="text-body text-foreground [text-wrap:pretty]">{challenge?.passkeyAvailable === false ? 'These permissions need a confirmation. This account has no passkey yet, so confirm with your recovery key.' : 'These permissions need your passkey: Allow asks for it.'}</p>
                  {confirming.error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{confirming.error}</p> : null}
                  {recovered ? <p role="status" className="text-caption text-foreground">Recovery key accepted. Allow to finish.</p> : null}
                  {challenge && !recovered ? <StepUpPrompt stepUp={challenge} recoveryOnly onProof={proof => setRecovery({ stepUp: challenge, proof })} /> : null}
                </section> : null}
                {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <Button type="button" variant="secondary" className={TAP} disabled={busy} onClick={() => { void decide(false); }}>Deny</Button>
                  <Button type="button" variant="primary" className={TAP} disabled={busy || !canAllow} loading={busy} onClick={() => { void decide(true); }}>Allow</Button>
                </div>
              </>}
      </CardContent>
    </Card>
  </main>;
}
