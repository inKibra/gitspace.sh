/**
 * Live model resolution for workflow-node identities (web loader).
 *
 * A workflow node names EITHER a registry agent OR an OMP model role — this
 * hook loads both vocabularies from the same seams the settings surfaces use:
 *  - agents: backend.listAgentDefinitions (AGENTS tab) collapsed to chip
 *    labels via agentResolutionLabel ('Current model', 'Thinking — gpt-…').
 *  - roles: the role catalog from backend.getAgentControlInfo (MODEL ROLES
 *    surface; the cold path needs no live agent session) as label + assigned
 *    model — task follows the session model (model null), an unset role shows
 *    how it inherits ('Default — <default's model>').
 *
 * Fetched once per pane load plus a slow poll, so chips follow AGENTS-tab
 * override changes. Null while loading or when the backend has no registry.
 */
import { useEffect, useState } from 'react';
import type { SessionBackend } from '../../session/backend.js';
import type { WorkflowLiveResolution } from '../../blocks/render/workflow.web.js';
import { agentResolutionLabel, MODEL_ROLE_LABELS } from '../../blocks/model-roles.js';

const POLL_MS = 20_000;

/** Synthetic session id — getAgentControlInfo's cold path serves the role
 *  catalog from settings when the id matches no live session. */
const NO_SESSION = 'workflow-pane';

export function useWorkflowResolution(
  backend: SessionBackend | null,
  workspaceId: string,
): WorkflowLiveResolution | null {
  const [resolution, setResolution] = useState<WorkflowLiveResolution | null>(null);

  useEffect(() => {
    setResolution(null);
    const list = backend?.listAgentDefinitions;
    if (!backend || !list) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [defs, control] = await Promise.all([
          list.call(backend, workspaceId),
          backend.getAgentControlInfo?.(workspaceId, NO_SESSION).catch(() => null) ?? Promise.resolve(null),
        ]);
        if (!alive) return;
        const agents: Record<string, string> = {};
        // Definitions arrive project > user > bundled; first wins on name
        // collisions (matches which definition a task spawn would use).
        for (const d of defs) { if (!(d.name in agents)) agents[d.name] = agentResolutionLabel(d); }
        const roles: WorkflowLiveResolution['roles'] = {};
        const catalog = control?.roleCatalog ?? [];
        const defaultModel = catalog.find((r) => r.role === 'default')?.model ?? null;
        for (const r of catalog) {
          const label = MODEL_ROLE_LABELS[r.role] ?? r.name ?? r.role;
          // task follows the session model — its label ('Current model') says
          // it all, no model suffix. An unset role inherits the Default role
          // first (matches the AGENTS tab's 'Default — <model>' shorthand).
          const model = r.role === 'task' ? null : r.model ?? (r.role !== 'default' && defaultModel ? `Default — ${defaultModel}` : null);
          roles[r.role] = { label, model };
        }
        setResolution({ agents, roles });
      } catch {
        /* keep the last good resolution (or null) */
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [backend, workspaceId]);

  return resolution;
}
