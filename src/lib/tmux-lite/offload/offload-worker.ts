/**
 * Offload worker — a child process for daemon work that must not block the
 * daemon event loop (review ops with GitHub network I/O were stalling it for
 * tens of seconds; see the 73s review-request trace).
 *
 * Same shape as agents/worker/agent-worker.ts: Bun.spawn + ipc, rpc dispatch
 * by allowlisted op name, disconnect/ppid watchdogs so it dies with the
 * daemon. Ops import their modules lazily — this process stays tiny until an
 * op actually runs, and each op family loads only what it needs.
 */

interface OffloadRpc {
  t: 'rpc';
  id: number;
  op: string;
  payload: unknown;
}

function send(msg: unknown): void {
  try {
    process.send?.(msg);
  } catch (err) {
    console.error('[offload-worker] IPC send failed; exiting:', err);
    process.exit(1);
  }
}

async function dispatch(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case 'review': {
      // Review executor scans workspaces itself (default scan impl).
      const { executeLocalReviewOperation } = await import('../../../core/review-executor.js');
      const { operation } = payload as { operation: never };
      return executeLocalReviewOperation(operation, undefined, { allowPrompt: false });
    }
    case 'artifacts-sync': {
      // git fetch/push + LFS blob transport — the recurring daemon-loop cost.
      const { syncGithubArtifacts } = await import('../../../core/artifacts-github.js');
      const { projectDir } = payload as { projectDir: string };
      return syncGithubArtifacts(projectDir);
    }
    default:
      throw new Error(`unknown offload op: ${op}`);
  }
}

process.on('message', (raw: unknown) => {
  const msg = raw as OffloadRpc | null;
  if (!msg || msg.t !== 'rpc' || typeof msg.id !== 'number') return;
  void (async () => {
    try {
      const result = await dispatch(msg.op, msg.payload);
      send({ t: 'rpc-result', id: msg.id, ok: true, result: result ?? null });
    } catch (err) {
      send({ t: 'rpc-result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

process.on('disconnect', () => {
  console.error('[offload-worker] daemon disconnected; exiting');
  process.exit(1);
});

const initialPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== initialPpid) {
    console.error(`[offload-worker] daemon gone (ppid ${initialPpid} -> ${process.ppid}); exiting`);
    process.exit(1);
  }
}, 5000);

console.log(`[offload-worker] started pid=${process.pid}`);

export {};
