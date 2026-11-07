import { executionHash, projectEnvironmentState, type LifecycleState } from '@gitspace/protocol-environment';
import { RuntimeEnvironmentArgumentsSchema, RuntimeLifecycleApprovalAnswerSchema, type RuntimeLifecycleApprovalQuestion, type RuntimeLifecycleApprovalRequest, type RuntimeLifecycleApprovalScript } from '@gitspace/protocol-runtime';
import type { ArtifactsRepositoryReader } from '@gitspace/runtime-workspace-do';

/** Commits of the working copy's history searched for an approved earlier version of a script. */
const HISTORY_DEPTH = 50;

/**
 * The card an agent's `environment` runPhase or runChecks call waits on: the executions it would run (the machine plans
 * the same ones: the phase's scripts, interactive ones skipped, or the profile's checks) that no approval names. Null
 * when every one is approved or the call runs nothing. A script's `previous` is the newest earlier version of its file
 * that is approved: first from the scripts of cards a person approved (`cards`), then from the working copy's history
 * (`history`, newest commit first).
 */
export async function lifecycleApprovalRequest(input: {
  args: unknown;
  state: LifecycleState;
  cards: readonly { answer: unknown; lifecycle?: RuntimeLifecycleApprovalQuestion }[];
  history: { reader: ArtifactsRepositoryReader; commit: string } | null;
}): Promise<RuntimeLifecycleApprovalRequest | null> {
  const args = RuntimeEnvironmentArgumentsSchema.safeParse(input.args);
  if (!args.success || (args.data.method !== 'runPhase' && args.data.method !== 'runChecks')) return null;
  const phase = args.data.method === 'runChecks' ? 'checks' : args.data.phase;
  const approvedBy = new Map<string, string>();
  for (const approval of input.state.approvals) if (approval.scope === 'project' || !approvedBy.has(approval.executionHash)) approvedBy.set(approval.executionHash, approval.approvedBy);
  const approvedCards = input.cards.filter(card => { const answer = RuntimeLifecycleApprovalAnswerSchema.safeParse(card.answer); return answer.success && answer.data !== 'not-now'; });
  const searchHistory = input.history ? historySearch(input.history, approvedBy) : null;
  const scripts: RuntimeLifecycleApprovalScript[] = [];
  for (const execution of projectEnvironmentState(input.state).executions) {
    if (execution.kind === 'ingress' || execution.approval !== null) continue;
    if (phase === 'checks' ? execution.kind !== 'check' : execution.kind !== 'script' || execution.phase !== phase || execution.interactive === true) continue;
    const script: RuntimeLifecycleApprovalScript = { hash: execution.hash, kind: execution.kind, label: execution.label, phase: execution.phase, fileName: execution.fileName, content: execution.content, previous: null };
    if (execution.phase !== null && execution.fileName !== null) {
      const shown = approvedCards.flatMap(card => card.lifecycle?.scripts ?? []).findLast(earlier => earlier.phase === execution.phase && earlier.fileName === execution.fileName && earlier.hash !== execution.hash && approvedBy.has(earlier.hash));
      const approver = shown ? approvedBy.get(shown.hash) : undefined;
      script.previous = shown && approver !== undefined ? { content: shown.content, approvedBy: approver }
        : searchHistory ? await searchHistory(`.gitspace/lifecycle/${execution.phase}/${execution.fileName}`, execution.hash) : null;
    }
    scripts.push(script);
  }
  return scripts.length === 0 ? null : { phase, scripts };
}

/** Searches the history of `commit`, newest first, for the newest version of a file whose content an approval names,
 * other than its current one. Trees and the log are read once for every file searched. */
function historySearch(history: { reader: ArtifactsRepositoryReader; commit: string }, approvedBy: ReadonlyMap<string, string>) {
  const { reader } = history;
  let commits: Promise<ArtifactsCommitMetadata[]> | undefined;
  const trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  const readTree = (oid: string) => {
    let entries = trees.get(oid);
    if (!entries) { entries = reader.readTree(oid); trees.set(oid, entries); }
    return entries;
  };
  return async (path: string, current: string): Promise<{ content: string; approvedBy: string } | null> => {
    const segments = path.split('/');
    const checked = new Set<string>();
    commits ??= reader.log(history.commit, HISTORY_DEPTH);
    for (const commit of await commits) {
      let oid: string | null = commit.treeHash;
      for (const [index, segment] of segments.entries()) {
        const entry: ArtifactsTreeEntry | undefined = oid === null ? undefined : (await readTree(oid))?.find(item => item.name === segment);
        oid = entry && (index === segments.length - 1 ? entry.type === 'blob' || entry.type === 'exec' : entry.type === 'tree') ? entry.hash : null;
      }
      if (oid === null || checked.has(oid)) continue;
      checked.add(oid);
      const content = await (await reader.readBlob(oid))?.text();
      if (content === undefined) continue;
      const hash = await executionHash({ kind: 'script', command: content });
      const approver = approvedBy.get(hash);
      if (hash !== current && approver !== undefined) return { content, approvedBy: approver };
    }
    return null;
  };
}
