import { useEffect, useRef, useState } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { WorkspaceDraftSchema, emptyWorkspaceDraft, type WorkspaceDraftSave, type WorkspaceDraftSaveResult } from '@gitspace/protocol-runtime/draft';
import { currentDevice } from './device-session.js';
import { WorkspaceDraftController, type WorkspaceDraftBinding, type WorkspaceDraftState } from './workspace-draft.js';

/** The existing runtime watch is the only remote subscription for drafts. */
export function useWorkspaceDraft(snapshot: RuntimeSnapshot, connected: boolean, save: (input: WorkspaceDraftSave) => Promise<WorkspaceDraftSaveResult>): WorkspaceDraftBinding | undefined {
  const key = JSON.stringify([snapshot.projectId, snapshot.workspaceId]);
  const latest = useRef({ snapshot, connected, save });
  latest.current = { snapshot, connected, save };
  const owner = useRef<{ key: string; controller: WorkspaceDraftController } | null>(null);
  const [view, setView] = useState<{ key: string; state: WorkspaceDraftState; controller: WorkspaceDraftController } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    let controller: WorkspaceDraftController | undefined;
    const hidden = () => { if (document.visibilityState === 'hidden') void controller?.flush(); };
    const online = () => controller?.setConnected(latest.current.connected);
    const pagehide = () => { void controller?.flush(); };
    void currentDevice().then((device) => {
      if (cancelled || !device) return;
      let storage: Storage | null = null;
      try { storage = window.localStorage; } catch { /* Cloud sync remains available when browser storage is denied. */ }
      controller = new WorkspaceDraftController({ deviceId: device.deviceId, key: `gitspace:draft:${JSON.stringify([device.userId, device.deviceId, snapshot.projectId, snapshot.workspaceId])}`, storage, save: input => save(input) });
      owner.current = { key, controller };
      const active = controller;
      stop = active.subscribe(() => setView({ key, controller: active, state: active.snapshot() }));
      const draft = WorkspaceDraftSchema.safeParse(latest.current.snapshot.documents['gitspace.draft'] ?? emptyWorkspaceDraft());
      if (draft.success) active.receive(draft.data);
      else active.rejectRemote();
      active.setConnected(draft.success && latest.current.connected);
      setView({ key, controller: active, state: active.snapshot() });
    });
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('online', online);
    window.addEventListener('pagehide', pagehide);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('online', online); window.removeEventListener('pagehide', pagehide);
      stop?.();
      if (controller) { void controller.flush().finally(() => controller?.dispose()); }
      if (owner.current?.key === key) owner.current = null;
    };
  }, [key]);
  useEffect(() => {
    const current = owner.current;
    if (!current || current.key !== key) return;
    const draft = WorkspaceDraftSchema.safeParse(snapshot.documents['gitspace.draft'] ?? emptyWorkspaceDraft());
    if (draft.success) current.controller.receive(draft.data);
    else current.controller.rejectRemote();
    current.controller.setConnected(draft.success && connected);
  }, [key, snapshot, connected]);
  if (view?.key !== key) return undefined;
  return { text: view.state.text, saving: view.state.saving, error: view.state.error, onChange: text => view.controller.edit(text), onBlur: () => { void view.controller.flush(); }, onDiscard: () => view.controller.discard(), capture: () => view.controller.capture(), accepted: capture => view.controller.accepted(capture) };
}
