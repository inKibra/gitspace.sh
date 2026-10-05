import { z } from 'zod';
import type { LoginState, LoginTransition, StoredOAuthCredential } from './schemas';
import { request, parseProvider, ProviderRefreshError } from './refresh';
import { completed, pending } from './login';
const loadSchema = z.object({ cloudaicompanionProject: z.string().optional(), currentTier: z.object({ id: z.string().optional() }).nullable().optional(), paidTier: z.object({ id: z.string().optional() }).nullable().optional(), allowedTiers: z.array(z.object({ id: z.string(), isDefault: z.boolean().optional() })).optional(), ineligibleTiers: z.array(z.object({ tierId: z.string().optional(), reasonMessage: z.string().optional() })).optional() });
const operationSchema = z.object({ name: z.string().optional(), done: z.boolean().optional(), error: z.object({ code: z.number().optional(), message: z.string().optional() }).nullable().optional(), response: z.object({ cloudaicompanionProject: z.union([z.string(), z.object({ id: z.string().optional() })]).optional() }).nullable().optional() });
function config(credential: StoredOAuthCredential) {
  const antigravity = credential.provider === 'google-antigravity';
  return { endpoint: antigravity ? 'https://daily-cloudcode-pa.googleapis.com' : 'https://cloudcode-pa.googleapis.com', headers: { Authorization: `Bearer ${credential.access}`, 'Content-Type': 'application/json', 'User-Agent': antigravity ? 'antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)' : 'GeminiCLI/0.46.0/gemini-3.1-pro-preview (linux; x64; terminal)', ...(antigravity ? {} : { 'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI' }) }, metadata: antigravity ? { ideType: 'ANTIGRAVITY' } : { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', ...(credential.projectId ? { duetProject: credential.projectId } : {}) } };
}
export async function discoverProject(state: LoginState, credential: StoredOAuthCredential, fetcher: typeof fetch): Promise<LoginTransition> {
  const { endpoint, headers, metadata } = config(credential);
  let load = parseProvider(credential.provider, loadSchema, await request(credential.provider, `${endpoint}/v1internal:loadCodeAssist`, { method: 'POST', headers, body: JSON.stringify({ metadata, cloudaicompanionProject: credential.projectId }) }, fetcher));
  if (credential.provider === 'google-antigravity' && !load.paidTier && load.cloudaicompanionProject) {
    load = parseProvider(credential.provider, loadSchema, await request(credential.provider, `${endpoint}/v1internal:loadCodeAssist`, { method: 'POST', headers, body: JSON.stringify({ metadata, cloudaicompanionProject: load.cloudaicompanionProject }) }, fetcher));
  }
  if (load.currentTier) {
    const projectId = load.cloudaicompanionProject || credential.projectId;
    if (projectId) return completed(state, { ...credential, projectId });
    return pending({ kind: 'project-input', provider: credential.provider, expiresAt: state.expiresAt, credential });
  }
  const tierId = credential.provider === 'google-antigravity' ? 'free-tier' : (load.allowedTiers?.find(t => t.isDefault)?.id ?? 'legacy-tier');
  if (credential.provider === 'google-antigravity' && !load.allowedTiers?.some(t => t.id === 'free-tier') && load.ineligibleTiers?.some(t => t.tierId === 'free-tier')) throw new ProviderRefreshError(credential.provider, 'rejected', 'This account is not eligible for Antigravity; complete provider account verification before signing in again');
  if (tierId !== 'free-tier' && !credential.projectId) return pending({ kind: 'project-input', provider: credential.provider, expiresAt: state.expiresAt, credential });
  const operation = parseProvider(credential.provider, operationSchema, await request(credential.provider, `${endpoint}/v1internal:onboardUser`, { method: 'POST', headers, body: JSON.stringify({ tierId, metadata, ...(tierId !== 'free-tier' ? { cloudaicompanionProject: credential.projectId } : {}) }) }, fetcher));
  return finishOperation(state, credential, operation, fetcher);
}
async function finishOperation(state: LoginState, credential: StoredOAuthCredential, operation: z.infer<typeof operationSchema>, fetcher: typeof fetch): Promise<LoginTransition> {
  if (operation.error) throw new ProviderRefreshError(credential.provider, 'rejected', 'Google project provisioning failed');
  if (!operation.done) {
    if (!operation.name || !/^operations\/[A-Za-z0-9_./-]+$/.test(operation.name) || operation.name.includes('..')) throw new ProviderRefreshError(credential.provider, 'invalid-response', 'Invalid Google provisioning operation');
    return pending({ kind: 'project', provider: credential.provider, expiresAt: state.kind === 'project' ? state.expiresAt : new Date(Math.min(Date.parse(state.expiresAt), Date.now() + 120_000)).toISOString(), credential, operation: operation.name, nextPollAt: new Date(Date.now() + 5000).toISOString() });
  }
  if (credential.provider === 'google-antigravity') {
    const { endpoint, headers, metadata } = config(credential);
    const load = parseProvider(credential.provider, loadSchema, await request(credential.provider, `${endpoint}/v1internal:loadCodeAssist`, { method: 'POST', headers, body: JSON.stringify({ metadata }) }, fetcher));
    if (!load.cloudaicompanionProject) throw new ProviderRefreshError(credential.provider, 'invalid-response', 'Google omitted provisioned project');
    return completed(state, { ...credential, projectId: load.cloudaicompanionProject });
  }
  const project = operation.response?.cloudaicompanionProject;
  const projectId = (typeof project === 'string' ? project : project?.id) || credential.projectId;
  if (!projectId) throw new ProviderRefreshError(credential.provider, 'invalid-response', 'Google omitted provisioned project');
  return completed(state, { ...credential, projectId });
}
export async function pollProject(state: Extract<LoginState, { kind: 'project' }>, fetcher: typeof fetch): Promise<LoginTransition> {
  const { endpoint, headers } = config(state.credential);
  const operation = parseProvider(state.provider, operationSchema, await request(state.provider, `${endpoint}/v1internal/${state.operation}`, { headers }, fetcher));
  return finishOperation(state, state.credential, operation, fetcher);
}
