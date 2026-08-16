import { createContext, useContext } from 'react';

// Lets block renderers open panes/artifacts without importing the app layer.
// `target` is a string the Shell maps to a pane: e.g. 'goal' | 'workflow' | 'rubric'
// | 'review' | 'report:<index>' | 'artifact:<name>'.
export interface PaneActions { open: (target: string) => void }

export const PaneActionsContext = createContext<PaneActions>({ open: () => {} });
export const usePaneActions = () => useContext(PaneActionsContext);
