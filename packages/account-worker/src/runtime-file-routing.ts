import type { RuntimeAttachment, RuntimeSnapshot } from '@gitspace/protocol-runtime';

type Placement = RuntimeSnapshot['conversations'][number]['placement'];
type ConversationRoute = { attachments: readonly RuntimeAttachment[]; placement: Placement; parent: boolean };

function conversationPlacement({ attachments, placement, parent }: ConversationRoute) {
  const placed = placement ? attachments.find(item => item.attachmentId === placement.attachmentId && item.generation === placement.generation) : undefined;
  return { placed, followsPrimary: !parent && (!placement || (placed?.role === 'primary' && placed.state === 'detached')) };
}

export function selectConversationAttachment(input: ConversationRoute): RuntimeAttachment | undefined {
  const { placed, followsPrimary } = conversationPlacement(input);
  return followsPrimary ? input.attachments.find(item => item.role === 'primary' && item.state === 'ready') : placed?.state === 'ready' ? placed : undefined;
}

export function routeRepositoryFile(input: ConversationRoute & { repositoryPath: boolean; cloudAttempt: boolean; machineAttempt: boolean }): 'cloud' | 'machine' {
  if (input.cloudAttempt && input.machineAttempt) throw new Error('Attempt has both cloud and machine ownership');
  if (input.cloudAttempt) return 'cloud';
  const { followsPrimary } = conversationPlacement(input);
  const primary = input.attachments.some(item => item.role === 'primary' && item.state !== 'detached');
  return input.repositoryPath && !primary && followsPrimary && !input.machineAttempt ? 'cloud' : 'machine';
}
