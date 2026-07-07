/** @jsxImportSource react */
/**
 * CronsPaneConnected — CronsPanel wired to the trigger registry RPCs.
 * Works for real workspaces AND the '<project>:@base' pseudo-workspace
 * (project-scope triggers), since every RPC routes through the @base-aware
 * target resolution. The daemon owns slugging, schedule validation, and the
 * run lifecycle (pending → ok/fail on session completion).
 */
import { useEffect, useState } from 'react';
import { CronsPanel, type Trigger } from './CronsPanel.web.js';
import { decodeBase64Utf8 } from './artifact-kinds.js';
import { toast } from '../lib/sonner.web.js';
import type { SessionBackend } from '../session/backend.js';
import type { TriggerRecord } from '../core/triggers.js';

export function CronsPaneConnected({ backend, workspaceId }: {
  backend: SessionBackend | null;
  workspaceId: string;
}) {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = backend?.listWorkspaceArtifacts;
      const read = backend?.readWorkspaceArtifact;
      if (!list || !read) return;
      try {
        const arts = await list.call(backend, workspaceId);
        const paths = arts.map((a) => a.path).filter((x) => x.startsWith('triggers/') && x.endsWith('.trigger.json'));
        const loaded = await Promise.all(paths.map(async (path) => {
          try { return JSON.parse(decodeBase64Utf8((await read.call(backend, workspaceId, path)).base64)) as Trigger; }
          catch { return null; }
        }));
        if (alive) setTriggers(loaded.filter((x): x is Trigger => x !== null));
      } catch { /* mount missing */ }
    })();
    return () => { alive = false; };
  }, [backend, workspaceId, tick]);

  return (
    <CronsPanel
      triggers={triggers}
      onSave={backend?.saveWorkspaceTrigger ? async (t) => {
        try {
          await backend.saveWorkspaceTrigger!(workspaceId, t as TriggerRecord);
          setTick((n) => n + 1);
          toast.success(`Trigger ${t.name} saved.`);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Failed to save trigger');
          throw e;
        }
      } : undefined}
      onRunNow={backend?.runWorkspaceTriggerNow ? async (t) => {
        if (!t.id) { toast.error('Trigger has no id — re-save it first.'); return; }
        try {
          await backend.runWorkspaceTriggerNow!(workspaceId, t.id);
          setTick((n) => n + 1);
          toast.success(`Trigger ${t.name} running — see the agent session ("trigger: ${t.name}").`);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Failed to run trigger');
        }
      } : undefined}
    />
  );
}
