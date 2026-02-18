/**
 * Process session list helpers
 */

import type { Session } from '../tmux-lite/protocol.js';
import { parseProcessSessionName } from './manager.js';

export function decorateSessionWithProcess(session: Session) {
  const parsed = parseProcessSessionName(session.name);
  return {
    ...session,
    processName: parsed?.processName,
    processInstance: parsed?.instance,
  };
}
