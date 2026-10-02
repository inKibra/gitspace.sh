import { accountDescriptions } from './descriptions/account.js';
import { sessionDescriptions } from './descriptions/sessions.js';
import { workspaceDescriptions } from './descriptions/workspaces.js';

/** Operation guidance is explicit; RPC names and kinds do not describe user-visible behavior. */
export const toolDescriptions: Readonly<Record<string, string>> = {
  ...accountDescriptions,
  ...sessionDescriptions,
  ...workspaceDescriptions,
};
