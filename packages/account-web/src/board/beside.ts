import { createContext } from 'react';

/** The workspace open beside the board: its header's sidebar toggle folds the board back to the list (`onFold`), its ✕
 * closes it, leaving the whole board (`onClose`). Null outside the board. */
export const BoardBesideContext = createContext<{ onFold(): void; onClose(): void } | null>(null);
