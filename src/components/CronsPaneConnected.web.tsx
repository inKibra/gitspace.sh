/** @jsxImportSource react */
/**
 * CronsPaneConnected — CronsPanel wired to the trigger registry RPCs.
 * Works for real workspaces AND the '<project>:@base' pseudo-workspace
 * (project-scope triggers), since every RPC routes through the @base-aware
 * target resolution. The daemon owns slugging, schedule validation, and the
 * run lifecycle (pending → ok/fail on session completion).
 */
import { useEffect, useState } from 'react';
import { CronsPanel, type TriggerIssue } from './CronsPanel.web.js';
import { decodeBase64Utf8 } from './artifact-kinds.js';
import { toast } from '../lib/sonner.web.js';
import type { SessionBackend } from '../session/backend.js';
import { parseJsonWith } from '../core/schema-parse.js';
import { triggerSchema, type TriggerRecord } from '../core/trigger-schema.js';
export function CronsPaneConnected({ backend, workspaceId }: {
  backend: SessionBackend | null;
  workspaceId: string;
}) {
  const [triggers, setTriggers] = useState<TriggerRecord[]>([]);
  const [triggerIssues, setTriggerIssues] = useState<TriggerIssue[]>([]);
  /** Bumped after a save or run-now to refetch the registry. */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = backend?.listWorkspaceArtifacts;
      const read = backend?.readWorkspaceArtifact;
      if (!list || !read) return;
      try {
        const arts = await list.call(backend, workspaceId);
        const paths = arts.map((a) => a.path).filter((x) => /^(?:triggers|goals\/[^/]+\/triggers)\/[^/]+\.trigger\.json$/.test(x));
        const loaded = await Promise.all(paths.map(async (path) => ({ path, raw: decodeBase64Utf8((await read.call(backend, workspaceId, path)).base64) })));
        const valid: TriggerRecord[] = [];
        const issues: TriggerIssue[] = [];
        for (const item of loaded) {
          const parsed = parseJsonWith(triggerSchema, item.raw);
          if (parsed.ok) valid.push(parsed.data);
          else issues.push({ path: item.path, issues: parsed.issues });
        }
        if (alive) { setTriggers(valid); setTriggerIssues(issues); }
      } catch { /* mount missing */ }
    })();
    return () => { alive = false; };
  }, [backend, workspaceId, tick]);

  return (
    <CronsPanel
      target={workspaceId}
      triggers={triggers}
      triggerIssues={triggerIssues}
      onSave={backend?.saveWorkspaceTrigger ? async (t) => {
        try {
          await backend.saveWorkspaceTrigger!(workspaceId, t);
          setTick((n: number) => n + 1);
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
          setTick((n: number) => n + 1);
          toast.success(`Trigger ${t.name} running — see the agent session ("trigger: ${t.name}").`);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Failed to run trigger');
        }
      } : undefined}
    />
  );
}
