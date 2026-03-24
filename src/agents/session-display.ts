export interface AgentSessionDisplayInput {
  id: string;
  title?: string;
  rawTitle?: string;
  parentID?: string;
}

const OPAQUE_AGENT_SESSION_ID_PATTERN = /^ses-[a-z0-9]+$/i;
const SUBAGENT_TITLE_PATTERN = /\(@[^)]+subagent\)/i;

export function isLikelySubagentTitle(title: string | undefined): boolean {
  return Boolean(title && SUBAGENT_TITLE_PATTERN.test(title));
}

export function isOpaqueAgentSessionId(id: string): boolean {
  return OPAQUE_AGENT_SESSION_ID_PATTERN.test(id.trim());
}

export function getAgentSessionDisplayTitle(input: Pick<AgentSessionDisplayInput, 'id' | 'title' | 'rawTitle'>): string {
  const rawTitle = typeof input.rawTitle === 'string' ? input.rawTitle.trim() : '';
  const explicitTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const candidate = rawTitle || explicitTitle;
  if (candidate.length > 0 && candidate !== input.id) {
    return candidate;
  }
  if (isOpaqueAgentSessionId(input.id)) {
    return 'Untitled agent session';
  }
  return explicitTitle || input.id;
}

export function shouldDisplayAgentSession(input: AgentSessionDisplayInput): boolean {
  if (input.parentID) {
    return false;
  }
  return !isLikelySubagentTitle(input.rawTitle ?? input.title);
}
