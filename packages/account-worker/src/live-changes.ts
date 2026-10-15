import { accountLiveKey, projectLiveKey, workspaceLiveKey, type LiveKey, type LiveNotice } from '@gitspace/protocol/live-notice';

/** A changed resource as tabs watch it. */
function liveKeyOfResource(resource: string): LiveKey {
  const separator = resource.indexOf(':');
  const kind = separator < 0 ? resource : resource.slice(0, separator);
  const id = resource.slice(separator + 1);
  switch (kind) {
    case 'project': return projectLiveKey(id, 'project');
    case 'environment':
    case 'space': return workspaceLiveKey(id, kind);
    default: return accountLiveKey(resource);
  }
}

/** Tells watching tabs which resources changed; a tab then reads the resource with a normal query. Nothing is stored. */
export class LiveChanges {
  private readonly changed = new Set<string>();
  /** `notify` receives one notice per changed resource after each committed write; it must not block the writer. */
  constructor(storage: Pick<DurableObjectStorage, 'sql'>, private readonly notify: (notices: LiveNotice[]) => void) {
    // One-time: changes were once stored for cursor replay.
    storage.sql.exec('DROP TABLE IF EXISTS app_changes; DROP TABLE IF EXISTS app_change_heads');
  }
  /** Inside the writing transaction; tabs hear of it at `wake`, after the commit. */
  mark(resource: string): void {
    this.changed.add(resource);
  }
  wake(): void {
    if (this.changed.size === 0) return;
    const version = Date.now();
    const notices = [...this.changed].map(resource => ({ ...liveKeyOfResource(resource), version }));
    this.changed.clear();
    this.notify(notices);
  }
}
