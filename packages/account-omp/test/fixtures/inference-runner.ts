import { complete, completeSimple, generateImage, type SimpleStreamOptions } from '@oh-my-pi/pi-ai';
import { createAgentSession, SessionManager, type ToolSession } from '@oh-my-pi/pi-coding-agent';
import { generateTitleOnline } from '@oh-my-pi/pi-coding-agent/utils/title-generator';
import { generateCommitMessage } from '@oh-my-pi/pi-coding-agent/utils/commit-message-generator';
import { describeAttachedImagesForTextModel } from '@oh-my-pi/pi-coding-agent/utils/image-vision-fallback';
import { getCompletionHandle, runEvalCompletion, releaseCompletionHandles } from '@oh-my-pi/pi-coding-agent/eval/completion-bridge';
import { requestOpenAiRemoteCompaction } from '@oh-my-pi/pi-agent-core/compaction/openai';
import { runSubprocess } from '@oh-my-pi/pi-coding-agent/task/executor';
import { createManagedInference } from '../../src/inference.js';
import type { InferenceExecutionContext } from '@gitspace/protocol/inference';

const input = JSON.parse(process.env.INFERENCE_FIXTURE!) as { context: InferenceExecutionContext; directory: string; operation: string };
const scope = await createManagedInference(input.context, { agentDir: input.directory, cwd: input.directory, installDispatchGuard: true });
const model = scope.modelRegistry.find('openai', 'profile-model')!;
const context = { messages: [{ role: 'user' as const, content: 'scope probe', timestamp: Date.now() }] };
try {
  let result: unknown;
  if (input.operation === 'helpers') {
    const sdk = await createAgentSession({
      cwd: input.directory, agentDir: input.directory, settings: scope.settings,
      authStorage: scope.authStorage, modelRegistry: scope.modelRegistry, model,
      sessionManager: SessionManager.inMemory(input.directory), tools: [], customTools: [],
      enableMCP: false, disableExtensionDiscovery: true, systemPrompt: 'Return a short answer.',
    });
    try {
      sdk.session.setAdvisorEnabled(true);
      await sdk.session.prompt('main SDK managed scope probe');
      await sdk.session.waitForAdvisorCatchup(10_000);
    }
    finally { await sdk.session.dispose(); }
    const task = await runSubprocess({
      cwd: input.directory, id: 'profile-task-probe', index: 0,
      agent: { name: 'scope-probe', description: 'Credential isolation probe', systemPrompt: 'Answer briefly and yield.', source: 'bundled', tools: [] },
      task: 'task descendant managed scope probe', description: 'Scope probe', modelOverride: 'openai/profile-task',
      modelRegistry: scope.modelRegistry, authStorage: scope.authStorage, settings: scope.settings,
      enableMCP: false, enableIrc: false, enableLsp: false, restrictToolNames: true,
      persistArtifacts: false, preloadedExtensionPaths: [], preloadedCustomToolPaths: [],
      skills: [], rules: [], contextFiles: [], maxRuntimeMs: 10_000,
    });
    if (task.exitCode !== 0) throw new Error(`Task scope probe failed: ${task.error ?? task.output}`);
    await generateTitleOnline('title managed scope probe', scope.modelRegistry, scope.settings, 'title', model);
    await generateCommitMessage('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n', scope.modelRegistry, scope.settings, 'commit');
    await describeAttachedImagesForTextModel([{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }], {
      activeModel: model, modelRegistry: scope.modelRegistry, settings: scope.settings,
      localProtocolOptions: { getArtifactsDir: () => input.directory, getSessionId: () => 'vision' },
    });
    const handle = await runEvalCompletion({ prompt: 'eval managed scope probe', model: 'default' }, {
      session: { settings: scope.settings, modelRegistry: scope.modelRegistry, getActiveModelString: () => 'openai/profile-model', getSessionId: () => 'eval', getAgentId: () => 'eval-profile-test' } as ToolSession,
    });
    const completion = getCompletionHandle(handle.id)!;
    await completion.promise;
    if (completion.error) throw new Error(completion.error);
    releaseCompletionHandles('eval-profile-test');
    result = { completed: true };
  } else if (input.operation === 'native-foreign') {
    result = await requestOpenAiRemoteCompaction(model, 'foreign-profile-key', [], 'Summarize');
  } else if (input.operation.startsWith('image')) {
    // Hosted generation: the profile's Responses model is both the image model and its carrier.
    const image = scope.modelRegistry.find('openai', 'profile-image')!;
    const target = input.operation === 'image-foreign' ? { ...image, baseUrl: image.baseUrl.replace('/provider/a/', '/provider/b/') } : image;
    const apiKey = input.operation === 'image-explicit' ? 'foreign-profile-key' : scope.modelRegistry.resolver(image, 'image');
    const generated = await generateImage(target, { prompt: 'image managed scope probe', count: 1 }, { apiKey, carrier: target, sessionId: 'image' });
    result = { stopReason: generated.images.length === 1 ? 'stop' : 'error' };
  } else if (input.operation === 'bedrock') {
    result = await completeSimple(scope.modelRegistry.find('amazon-bedrock', 'profile-bedrock')!, context);
  } else if (input.operation === 'explicit') {
    result = await complete(model, context, { apiKey: 'foreign-profile-key' });
  } else if (input.operation === 'header') {
    result = await completeSimple(model, context, { headers: { Authorization: 'Bearer foreign-profile-key' } });
  } else if (input.operation === 'model-header') {
    result = await completeSimple({ ...model, headers: { 'X-Api-Key': 'foreign-profile-key' } }, context);
  } else if (input.operation === 'retry-foreign') {
    const resolver: NonNullable<SimpleStreamOptions['apiKey']> = async ({ error }) => error ? 'foreign-profile-key' : scope.authStorage.getApiKey('openai');
    result = await completeSimple(model, context, { apiKey: resolver });
  } else {
    result = await completeSimple(model, context);
  }
  const response = result as { stopReason?: string; errorMessage?: string };
  process.stdout.write(`${JSON.stringify({ ok: response?.stopReason !== 'error', error: response?.errorMessage })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
} finally {
  scope.close();
}
process.exit(0);
