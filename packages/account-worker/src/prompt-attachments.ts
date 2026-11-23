import { chatAttachmentTag, type ChatAttachment, type PromptAttachment } from '@gitspace/protocol-runtime/chat-attachments';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime/session-controls';
import { InspectorCloudArtifacts, readInspectorContext } from './account-inspector-data.js';

type PromptCommand = Extract<RuntimeSessionCommand, { type: 'prompt' }>;

/** The file one attachment names: a `url` fetched into `folder`, or a `driveUrl` as its file is now. */
async function attached(artifacts: InspectorCloudArtifacts, attachment: PromptAttachment, folder: string): Promise<ChatAttachment> {
  if ('url' in attachment) {
    const artifact = await artifacts.importUrl(attachment.url, { folder, mediaType: attachment.mediaType, ...(attachment.name === undefined ? {} : { fileName: attachment.name }) });
    return { name: attachment.name ?? artifact.path.slice(artifact.path.lastIndexOf('/') + 1), url: artifact.url, type: attachment.mediaType, size: artifact.size, hash: artifact.hash };
  }
  const file = await artifacts.grant(attachment.driveUrl);
  return { name: attachment.name ?? file.name, url: attachment.driveUrl, type: attachment.mediaType, size: file.size, hash: file.hash };
}

/**
 * A prompt's `attachments` as a person's attached files reach the agent (`chat-attachments.ts`): each `url` is imported
 * into `uploads/<YYYY-MM-DD>/` of the workspace's drive under the guards of `inspector.artifacts.import`, each
 * `driveUrl` must name a file this workspace reads, and the prompt goes on without them, its text followed by one
 * `<attachment … />` tag per file, as the composer sends a message. The workspace then makes each file's rendition
 * before the turn, as for any attached file. One that cannot be fetched or found fails the prompt.
 */
export async function resolvePromptAttachments(env: Env, userId: string, identity: { projectId: string; workspaceId: string }, command: PromptCommand): Promise<PromptCommand> {
  const { attachments, ...prompt } = command;
  if (!attachments) return command;
  const artifacts = new InspectorCloudArtifacts(env, userId, await readInspectorContext(env, userId, identity.workspaceId, identity.projectId));
  const folder = `uploads/${new Date().toISOString().slice(0, 10)}`;
  const files = await Promise.all(attachments.map(attachment => attached(artifacts, attachment, folder)));
  return { ...prompt, text: [...(prompt.text ? [prompt.text] : []), ...files.map(chatAttachmentTag)].join('\n\n') };
}
