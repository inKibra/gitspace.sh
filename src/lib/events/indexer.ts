/**
 * Wide event index maintenance helpers
 */

import { writeFileSync } from 'fs';
import type { WideEventIndex } from '../../types/events.js';

export function writeIndexFile(path: string, index: WideEventIndex): void {
  const data = {
    ...index,
    minTs: index.minTs === Number.POSITIVE_INFINITY ? index.maxTs : index.minTs,
  };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}
