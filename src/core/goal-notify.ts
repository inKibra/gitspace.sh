/**
 * Fire-and-forget daemon notify for goal.json writes (ticket #3).
 *
 * The space CLI mutates goal state on disk in a separate process — the daemon
 * cannot see those writes, which is why the web rubric previously ran a 5s
 * poll. Goal writers queue their project here; the CLI entrypoint flushes the
 * queue once, after the command action, with a short bounded deadline:
 * a `goal-changed` router command makes the daemon re-read that project's
 * goals and emit scoped machine deltas to every watching client.
 *
 * Failure is always swallowed: no daemon (or a wedged one) must never break
 * or slow a goal write.
 */

let suppressed = false;
const pendingProjects = new Set<string>();

/** The daemon suppresses self-notify — its own goal mutations already apply
 *  scoped updates directly. */
export function suppressGoalChangeNotify(): void {
  suppressed = true;
}

/** Record that a project's goal state changed on disk. Cheap and sync —
 *  callers are the goal write functions themselves. */
export function queueGoalChangeNotify(projectName: string): void {
  if (suppressed) return;
  pendingProjects.add(projectName);
}

/** Pending queue size (used by the flush guard and tests). */
export function pendingGoalChangeNotifyCount(): number {
  return pendingProjects.size;
}

/** Test hook: reset module state. */
export function resetGoalChangeNotifyForTests(): void {
  suppressed = false;
  pendingProjects.clear();
}

export interface GoalChangeNotifySender {
  (projectName: string, timeoutMs: number): Promise<void>;
}

async function defaultSender(projectName: string, timeoutMs: number): Promise<void> {
  const { send } = await import('../lib/tmux-lite/cli.js');
  await send({ type: 'goal-changed', projectName }, { timeoutMs });
}

/**
 * Flush queued notifies to the daemon. Bounded and best-effort: skips when no
 * daemon socket exists, never throws, never spawns a daemon.
 */
export async function flushGoalChangeNotify(
  options: { timeoutMs?: number; sender?: GoalChangeNotifySender } = {},
): Promise<void> {
  if (suppressed || pendingProjects.size === 0) return;
  const timeoutMs = options.timeoutMs ?? 800;
  const projects = Array.from(pendingProjects);
  pendingProjects.clear();
  try {
    let sender = options.sender;
    if (!sender) {
      const { getRouterSocket } = await import('../lib/tmux-lite/cli.js');
      const { existsSync } = await import('fs');
      // No socket file → no daemon → nothing to notify (and never spawn one).
      if (!existsSync(getRouterSocket())) return;
      sender = defaultSender;
    }
    await Promise.all(projects.map(async (projectName) => {
      try {
        await sender(projectName, timeoutMs);
      } catch {
        // fire-and-forget
      }
    }));
  } catch {
    // fire-and-forget
  }
}
