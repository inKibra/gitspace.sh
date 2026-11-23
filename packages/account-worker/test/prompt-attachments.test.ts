import { createHash } from 'node:crypto';
import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { chatAttachments, chatAttachmentTag } from '@gitspace/protocol-runtime/chat-attachments';
import { InspectorCloudArtifacts, readInspectorContext } from '../src/account-inspector-data.js';
import { resolvePromptAttachments } from '../src/prompt-attachments.js';
import { network } from './network.js';
import { dnsAnswers, png } from './public-network.js';
import { tenantRootPrivateKey } from './setup.js';

/** A project with one worktree workspace, and that workspace's drive. */
async function workspace() {
  const userId = env.ACCOUNT_ID;
  await env.CREDENTIALS.getByName(userId).bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Attachments', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const index = env.USER_PROJECTS.getByName(userId);
  await index.put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [workspaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind, branch: 'main', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await index.putWorkspaceLocation(id, projectId);
  }
  const drive = new InspectorCloudArtifacts(env, userId, await readInspectorContext(env, userId, workspaceId, projectId));
  return { identity: { projectId, workspaceId }, drive };
}

it('fetches a prompt\'s URL attachment into the uploads folder and names it, and a drive file, by the tags a pasted file gives', async () => {
  const { identity, drive } = await workspace();
  network.use(dnsAnswers({ 'files.example.com': { A: ['93.184.216.34'] } }), http.get('https://files.example.com/signed/screenshot.png', () => new HttpResponse(png, { headers: { 'content-type': 'image/png' } })));
  const notes = (await drive.write('drive://workspace/notes.txt', { bytes: new TextEncoder().encode('Ship on Friday.'), mediaType: 'text/plain' })).artifact;
  const command = await resolvePromptAttachments(env, env.ACCOUNT_ID, identity, {
    type: 'prompt', text: 'What does this show?', requestId: 'attach-1',
    attachments: [{ url: 'https://files.example.com/signed/screenshot.png', mediaType: 'image/png' }, { driveUrl: 'drive://workspace/notes.txt', mediaType: 'text/plain', name: 'Plan notes' }],
  });
  const [screenshot] = chatAttachments(command.text);
  expect(screenshot?.url).toMatch(/^drive:\/\/workspace\/uploads\/\d{4}-\d{2}-\d{2}\/screenshot\.png$/u);
  const hash = `sha256:${createHash('sha256').update(png).digest('hex')}`;
  // The prompt goes on without its attachments: its text, then the tags the composer adds for attached files.
  expect(command).toEqual({
    type: 'prompt', requestId: 'attach-1',
    text: ['What does this show?', chatAttachmentTag({ name: 'screenshot.png', url: screenshot!.url, type: 'image/png', size: png.byteLength, hash }), chatAttachmentTag({ name: 'Plan notes', url: 'drive://workspace/notes.txt', type: 'text/plain', size: notes.size, hash: notes.hash })].join('\n\n'),
  });
  // The fetched file is in the workspace's drive, as an upload from the browser would be.
  expect((await drive.list()).find(artifact => artifact.url === screenshot!.url)).toMatchObject({ hash, size: png.byteLength, mediaType: 'image/png', scope: 'workspace' });
});

it('fails a prompt whose drive attachment names no file, or whose URL attachment cannot be fetched', async () => {
  const { identity, drive } = await workspace();
  await drive.write('drive://workspace/present.png', { bytes: png, mediaType: 'image/png' });
  network.use(dnsAnswers({ 'internal.example.com': { A: ['10.0.0.5'] } }));
  await expect(resolvePromptAttachments(env, env.ACCOUNT_ID, identity, { type: 'prompt', text: 'Look', attachments: [{ driveUrl: 'drive://workspace/missing.png', mediaType: 'image/png' }] })).rejects.toThrow('Artifact does not exist');
  await expect(resolvePromptAttachments(env, env.ACCOUNT_ID, identity, { type: 'prompt', text: 'Look', attachments: [{ url: 'https://internal.example.com/shot.png', mediaType: 'image/png' }] })).rejects.toThrow('private or local address');
});
