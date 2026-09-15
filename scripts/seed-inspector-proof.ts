import { createGitSpaceBrowserClient } from '../packages/account-web/src/rpc-client.js';

const rpcUrl = process.env.GITSPACE_PROOF_RPC_URL ?? 'http://127.0.0.1:4510/rpc';
const projectId = process.env.GITSPACE_PROOF_PROJECT ?? 'project-a';
const workspaceId = process.env.GITSPACE_PROOF_WORKSPACE ?? 'workspace-a';
const client = createGitSpaceBrowserClient({ url: rpcUrl });

async function value<T>(result: Promise<{ status: 'ok'; value: T } | { status: 'error'; error: unknown }>): Promise<T> {
  const settled = await result;
  if (settled.status === 'error') throw settled.error;
  return settled.value;
}

const bootstrap = await value(client.bootstrap({ projectId, workspaceId }));
const space = bootstrap.workspaces.find((candidate) => candidate.id === workspaceId);
if (!space) throw new Error(`Workspace ${workspaceId} does not exist`);
const generation = space.spaceGeneration;
const identity = { projectId, spaceId: workspaceId };
const existing = await value(client.inspector.overview({ spaceId: workspaceId, expectedGeneration: generation }));
const resuming = existing.goal?.id === 'inspector-proof';

if (!resuming) {
const terminal = await value(client.terminals.create({ spaceId: workspaceId }));
const baseSource = Buffer.from('export interface ProofRecord { id: string; state: "ready" | "blocked"; }\n').toString('base64');
const finalSource = Buffer.from('export interface ProofRecord { id: string; state: "ready" | "blocked"; evidence: string[]; }\n\nexport function ready(record: ProofRecord): boolean {\n  return record.state === "ready" && record.evidence.length > 0;\n}\n').toString('base64');
const testSource = Buffer.from('import { expect, test } from "bun:test";\nimport { ready } from "./proof";\ntest("requires evidence", () => expect(ready({ id: "a", state: "ready", evidence: ["report"] })).toBe(true));\n').toString('base64');
const shell = [
  'set -e',
  'git config user.email proof@gitspace.sh',
  'git config user.name "GitSpace Proof"',
  'mkdir -p src',
  `printf %s ${baseSource} | base64 -d > src/proof.ts`,
  'git add src/proof.ts',
  'git commit -m "proof: establish inspector model" >/dev/null',
  `printf %s ${finalSource} | base64 -d > src/proof.ts`,
  `printf %s ${testSource} | base64 -d > src/proof.test.ts`,
  'git add src/proof.ts src/proof.test.ts',
  'git commit -m "proof: connect evidence review" >/dev/null',
  'printf "__GITSPACE_PROOF_READY__\\n"',
].join(' && ');
await value(client.terminals.send({ spaceId: workspaceId, name: terminal.name, data: `${shell}\n` }));
let terminalCursor: number | null = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  const output = await value(client.terminals.read({ spaceId: workspaceId, name: terminal.name, cursor: terminalCursor }));
  terminalCursor = output.cursor;
  if (output.data.includes('__GITSPACE_PROOF_READY__')) break;
  if (attempt === 99) throw new Error('Timed out preparing Inspector proof repository');
  await Bun.sleep(100);
}
await value(client.terminals.stop({ spaceId: workspaceId, name: terminal.name }));
}

if (resuming) {
  const terminal = await value(client.terminals.create({ spaceId: workspaceId }));
  const proofFiles: Record<string, string> = {
    'src/authority.ts': 'export const authorityLayers = ["goal", "workflow", "rubric", "journal", "guide"] as const;\n',
    'src/renderer.ts': 'export function renderEvidence(label: string): string { return `Evidence: ${label}`; }\n',
    'src/assignment.ts': 'export interface Assignment { projectSpace: boolean; workspaces: boolean; }\n',
    'src/authority.test.ts': 'import { expect, test } from "bun:test";\nimport { authorityLayers } from "./authority";\ntest("keeps typed layers", () => expect(authorityLayers).toHaveLength(5));\n',
    'docs/inspector-proof.md': '# Inspector proof\n\nThe long review fixture exercises navigation and scrolling across typed sections.\n',
    'web/inspector-proof.tsx': 'export function InspectorProof() { return <section>Scrollable review proof</section>; }\n',
  };
  const writes = Object.entries(proofFiles).map(([path, source]) => {
    const directory = path.slice(0, path.lastIndexOf('/'));
    return `mkdir -p ${directory} && printf %s ${Buffer.from(source).toString('base64')} | base64 -d > ${path}`;
  });
  const shell = `if [ -z "$(git log --format=%H --grep='^proof: repair scrolling review$' -n 1)" ]; then ${writes.join(' && ')} && git add ${Object.keys(proofFiles).join(' ')} && git commit -m "proof: repair scrolling review" >/dev/null; fi && printf "__GITSPACE_PROOF_EXPANDED__\\n"`;
  await value(client.terminals.send({ spaceId: workspaceId, name: terminal.name, data: `${shell}\n` }));
  let cursor: number | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = await value(client.terminals.read({ spaceId: workspaceId, name: terminal.name, cursor }));
    cursor = output.cursor;
    if (output.data.includes('__GITSPACE_PROOF_EXPANDED__')) break;
    if (attempt === 99) throw new Error('Timed out expanding Inspector proof repository');
    await Bun.sleep(100);
  }
  await value(client.terminals.stop({ spaceId: workspaceId, name: terminal.name }));
}

const firstWorksheet = await value(client.inspector.guide.analyze({ ...identity, expectedGeneration: generation, baseRef: 'HEAD~1' }));
const headCommit = firstWorksheet.headCommit;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#312e81"/></linearGradient></defs><rect width="960" height="540" rx="28" fill="url(#g)"/><text x="64" y="92" fill="#a5b4fc" font-family="system-ui" font-size="24">GITSPACE INSPECTOR PROOF</text><text x="64" y="176" fill="white" font-family="system-ui" font-size="52" font-weight="700">Evidence stays reviewable.</text><rect x="64" y="236" width="832" height="190" rx="18" fill="#ffffff" fill-opacity=".08"/><text x="96" y="292" fill="#dbeafe" font-family="monospace" font-size="24">Goal → Workflow → Rubric</text><text x="96" y="340" fill="#dbeafe" font-family="monospace" font-size="24">Journal → Change Guide</text><text x="96" y="388" fill="#86efac" font-family="monospace" font-size="24">Artifacts: image · report · mini-app</text></svg>`;
const report = `# Inspector proof report\n\n## Result\n\nThe typed Inspector authority, Git review surface, evidence artifacts, Journal, rubric, workflow, and Change Guide are populated together.\n\n- Repository generation: ${generation}\n- HEAD: ${headCommit}\n- Artifact previews remain available after this test.\n`;
const miniApp = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0f172a;color:#e2e8f0;font:14px system-ui;padding:24px}h1{color:#a5b4fc}.metric{display:inline-grid;margin:8px;padding:14px 20px;border-radius:12px;background:#1e293b}.metric b{font-size:28px;color:#86efac}</style><h1>GitSpace Inspector proof</h1><div class="metric"><b>8</b><span>surfaces</span></div><div class="metric"><b>4</b><span>evidence kinds</span></div><div class="metric"><b>1</b><span>typed authority</span></div><script>addEventListener('message',e=>{if(e.data?.type==='gssh:data')document.body.dataset.loaded='true'})</script>`;
const data = JSON.stringify({ title: 'Inspector proof', surfaces: ['Goal', 'Workflow', 'Rubric', 'Journal', 'Change Guide', 'Files', 'Artifacts', 'Services'], passed: true }, null, 2);
const artifactInputs = [
  ['local://workspace/evidence/inspector-proof.svg', 'image/svg+xml', svg],
  ['local://workspace/reports/inspector-proof.md', 'text/markdown', report],
  ['local://workspace/apps/inspector-proof.gssh.html', 'text/html', miniApp],
  ['local://workspace/data/inspector-proof.data.json', 'application/json', data],
] as const;
const artifactViews = [];
for (const [url, mediaType, source] of artifactInputs) {
  artifactViews.push(await value(client.inspector.artifacts.write({ spaceId: workspaceId, expectedGeneration: generation, url, mediaType, base64: Buffer.from(source).toString('base64') })));
}
const artifactEvidence = artifactViews.map((artifact) => ({
  kind: 'artifact' as const,
  url: artifact.url,
  hash: artifact.hash as `sha256:${string}`,
  generation,
  label: artifact.path.split('/').at(-1) ?? artifact.path,
  mediaType: artifact.mediaType,
}));
const gitFile = await value(client.inspector.repository.file({ spaceId: workspaceId, expectedGeneration: generation, mode: 'current', path: 'src/proof.ts' }));
const gitEvidence = { kind: 'git' as const, generation, path: 'src/proof.ts', blobId: gitFile.blobId, commitId: gitFile.commitId, label: 'Proof model implementation' };

const goal = await value(client.inspector.goal.put({
  expectedGeneration: generation,
  input: { ...identity, expectedRevision: existing.goal?.revision ?? 0, goal: {
    id: 'inspector-proof', title: 'Prove the complete Inspector review loop', summary: 'Keep typed product context, repository review, and visual evidence together without artifact-backed control documents.', phase: 'review', updatedBy: 'proof-seeder',
    requirements: [
      { id: 'proof-authority', title: 'Typed authority is durable', description: 'Goal, Workflow, Rubric, Journal, and Change Guide share one portable authority.', required: true, status: 'review', workflowNodeId: 'verify', criterionId: 'authority', evidence: [artifactEvidence[1]!, gitEvidence] },
      { id: 'proof-visuals', title: 'Visual evidence renders inline', description: 'Image, report, and mini-app evidence open from the Inspector.', required: true, status: 'review', workflowNodeId: 'evidence', criterionId: 'visuals', evidence: [artifactEvidence[0]!, artifactEvidence[2]!, artifactEvidence[3]!] },
    ],
  } },
}));
await value(client.inspector.workflow.put({ expectedGeneration: generation, input: { ...identity, expectedRevision: existing.workflow?.revision ?? 0, workflow: {
  id: 'inspector-proof-workflow', title: 'Inspector proof workflow', description: 'Typed context flows into evidence and a human review gate.', updatedBy: 'proof-seeder',
  nodes: [
    { id: 'verify', kind: 'phase', label: 'Verify authority', position: { x: 20, y: 80 }, status: 'complete', role: 'reviewer', reads: ['Goal', 'Journal'], writes: ['Rubric judgment'] },
    { id: 'evidence', kind: 'artifact', label: 'Visual evidence', position: { x: 300, y: 80 }, status: 'available', evidence: artifactEvidence[0]! },
    { id: 'human-gate', kind: 'gate', label: 'Human review', position: { x: 580, y: 80 }, requirementIds: ['proof-authority', 'proof-visuals'] },
  ], edges: [{ id: 'verify-evidence', from: 'verify', to: 'evidence', kind: 'data', label: 'produces' }, { id: 'evidence-gate', from: 'evidence', to: 'human-gate', kind: 'control', label: 'review' }],
} } }));
const rubric = await value(client.inspector.rubric.put({ expectedGeneration: generation, input: { ...identity, expectedRevision: existing.rubric?.revision ?? 0, rubric: {
  id: 'inspector-proof-rubric', title: 'Inspector proof review contract', description: 'Human, LLM, and command judges retain their evidence.', updatedBy: 'proof-seeder',
  criteria: [
    { id: 'authority', title: 'Typed authority survives review', description: 'Authority records remain queryable and revisioned.', workflowNodeId: 'verify', requirementIds: ['proof-authority'], judge: { kind: 'human' }, evidence: [artifactEvidence[1]!] },
    { id: 'visuals', title: 'Evidence renders inline', description: 'The proof image and mini-app are visible.', workflowNodeId: 'evidence', requirementIds: ['proof-visuals'], judge: { kind: 'llm', model: 'openai-codex/gpt-5.6-sol' }, evidence: [artifactEvidence[0]!, artifactEvidence[2]!] },
    { id: 'tests', title: 'Repository behavior is guarded', description: 'The proof test passes.', workflowNodeId: 'verify', requirementIds: ['proof-authority'], judge: { kind: 'command', command: 'bun test src/proof.test.ts', expectation: { kind: 'exit-zero' } }, evidence: [gitEvidence] },
  ],
} } }));
await value(client.inspector.rubric.appendJudgment({ expectedGeneration: generation, input: { ...identity, expectedRevision: rubric.revision, criterionId: 'visuals', judgment: { id: `visuals-judgment-${crypto.randomUUID()}`, kind: 'llm', verdict: 'pass', summary: 'The image and sandboxed mini-app both carry stable evidence references.', actorId: 'proof-seeder', model: 'openai-codex/gpt-5.6-sol', evidence: [artifactEvidence[0]!, artifactEvidence[2]!], createdAt: new Date().toISOString() } } }));
const journalEntries = await value(client.inspector.journal.list({ spaceId: workspaceId, expectedGeneration: generation }));
const journalIds = new Set(journalEntries.map((entry) => entry.id));
const journalFixtures = [
  { id: 'proof-decision', kind: 'decision' as const, phase: 'plan', title: 'Keep Inspector documents in typed authority', body: 'The 0.x review semantics were retained while artifact-backed control documents were removed.', outcome: 'Movement no longer forks review state.', decisions: ['Artifacts are evidence only.', 'Guide narration is grounded in Journal entries.'], evidence: [gitEvidence, artifactEvidence[1]!] },
  { id: 'proof-authority-map', kind: 'narrative' as const, phase: 'plan', title: 'Mapped the authority boundary', body: 'Goal, Workflow, Rubric, Journal, and Change Guide now share the same project and space identity.', outcome: 'Review state has one canonical owner.', decisions: ['Keep repository data separate from review authority.'], evidence: [gitEvidence] },
  { id: 'proof-workflow', kind: 'decision' as const, phase: 'code', title: 'Connected workflow gates', body: 'Workflow nodes now carry the evidence and requirement relationships needed by the human review gate.', outcome: 'The review sequence is explicit.', decisions: ['Human gates remain visible even when automated checks pass.'], evidence: [artifactEvidence[3]!] },
  { id: 'proof-renderer', kind: 'narrative' as const, phase: 'code', title: 'Built the evidence renderer', body: 'Images, Markdown reports, JSON records, and mini-apps use typed artifact previews instead of generic download links.', outcome: 'Evidence is inspectable without leaving the review flow.', decisions: [], evidence: artifactEvidence },
  { id: 'proof-threading', kind: 'decision' as const, phase: 'code', title: 'Pinned review threads to repository identity', body: 'Review comments retain generation, commit, blob, file, and line identity so stale anchors are visible.', outcome: 'Movement cannot silently retarget feedback.', decisions: ['Show stale state instead of guessing a replacement anchor.'], evidence: [gitEvidence] },
  { id: 'proof-diff', kind: 'narrative' as const, phase: 'review', title: 'Verified the repository diff', body: 'The Inspector file tree and diff viewer agree on the current generation and selected repository mode.', outcome: 'Reviewers can move between narrative and source evidence.', decisions: [], evidence: [gitEvidence] },
  { id: 'proof-rubric', kind: 'decision' as const, phase: 'review', title: 'Recorded rubric judgments', body: 'Human, LLM, and command judges retain independent verdicts and evidence references.', outcome: 'Acceptance remains explainable.', decisions: ['Do not collapse heterogeneous judges into one status.'], evidence: [artifactEvidence[1]!] },
  { id: 'proof-artifacts', kind: 'artifact' as const, phase: 'review', title: 'Attached visual proof', body: 'The Inspector proof image, report, data record, and mini-app were written to the workspace evidence scope.', outcome: 'All evidence remains visible after verification.', decisions: [], evidence: artifactEvidence },
  { id: 'proof-guide-analysis', kind: 'narrative' as const, phase: 'review', title: 'Analyzed review clusters', body: 'The deterministic analyzer grouped source, tests, documentation, and web presentation into a reader order.', outcome: 'The Change Guide can narrate multiple chapters.', decisions: [], evidence: [gitEvidence] },
  { id: 'proof-guide-narration', kind: 'decision' as const, phase: 'review', title: 'Narrated the Change Guide', body: 'Each analyzed cluster receives an explanation, motivation, exhibits, and deliberate reviewer attention.', outcome: 'The guide scrolls as a complete change story.', decisions: ['Keep mechanical and decision chapters visually distinct.'], evidence: [artifactEvidence[1]!] },
  { id: 'proof-scroll', kind: 'narrative' as const, phase: 'verify', title: 'Exercised long-form scrolling', body: 'The chapter rail, walkthrough, evidence log, and sticky controls were exercised with content longer than the viewport.', outcome: 'Scrolling behavior is observable instead of inferred.', decisions: [], evidence: [artifactEvidence[0]!] },
  { id: 'proof-keyboard', kind: 'narrative' as const, phase: 'verify', title: 'Checked keyboard navigation', body: 'Focus traverses the chapter rail, guide actions, evidence cards, and Journal filters without losing the active item.', outcome: 'The long review remains operable without a pointer.', decisions: [], evidence: [] },
  { id: 'proof-responsive', kind: 'narrative' as const, phase: 'verify', title: 'Checked responsive review layouts', body: 'The same long fixture was reviewed at desktop, tablet, and mobile widths.', outcome: 'Narrative and evidence remain reachable at each breakpoint.', decisions: [], evidence: [artifactEvidence[0]!] },
  { id: 'proof-complete', kind: 'decision' as const, phase: 'ship', title: 'Accepted the Inspector proof scenario', body: 'Typed authority, repository evidence, long Journal history, and the multi-section Change Guide now remain populated together.', outcome: 'The scenario is durable and repeatable.', decisions: ['Keep this fixture idempotent for future visual review.'], evidence: artifactEvidence },
] as const;
for (const fixture of journalFixtures) {
  if (journalIds.has(fixture.id)) continue;
  await value(client.inspector.journal.append({ expectedGeneration: generation, input: { ...identity, ...fixture, createdBy: 'proof-seeder' } }));
}

const worksheet = await value(client.inspector.guide.analyze({ ...identity, expectedGeneration: generation, baseRef: 'HEAD~1' }));
const sections = worksheet.clusters.map((cluster, index) => ({
  id: cluster.id,
  title: cluster.beat ? `Step ${cluster.beat.sequence} — ${cluster.kind}` : `Step ${index + 1} — ${cluster.kind}`,
  kind: cluster.kind === 'sweep' ? 'mechanical' as const : cluster.kind === 'tests' ? 'risk' as const : 'decision' as const,
  explanation: `This step groups ${cluster.files.join(', ')} in the analyzer's reader order.`,
  why: cluster.journal[0]?.body ?? 'The deterministic analyzer identified this as a coherent review unit.',
  exhibits: cluster.files.slice(0, 2).map((path) => ({ path, blobId: null, note: 'Review this file in the context of the step.', slowRead: cluster.kind !== 'sweep' })),
  requirementIds: [],
  contentHash: cluster.contentHash,
  journalEntryIds: cluster.journal.map((entry) => entry.entryId),
}));
await value(client.inspector.guide.submit({ ...identity, expectedGeneration: generation, expectedRevision: worksheet.guideRevision, headCommit: worksheet.headCommit, baseRef: worksheet.baseRef, title: 'Inspector proof — the change as a story', sections, createdBy: 'proof-narrator' }));
const existingThreads = await value(client.inspector.review.list({ spaceId: workspaceId, expectedGeneration: generation }));
if (!existingThreads.some((thread) => thread.id === 'proof-thread')) {
  await value(client.inspector.review.create({ expectedGeneration: generation, input: { ...identity, id: 'proof-thread', anchor: { kind: 'file', path: 'src/proof.ts', generation, commitId: gitFile.commitId, blobId: gitFile.blobId }, decision: 'pending', message: { id: 'proof-thread-root', authorId: 'proof-reviewer', body: 'Confirm this evidence requirement remains stable after movement.', createdAt: new Date().toISOString() } } }));
}

console.log(`Inspector proof seeded in ${projectId}/${workspaceId} at ${worksheet.headCommit.slice(0, 7)} with ${artifactViews.length} persistent artifacts and ${sections.length} guide sections.`);
