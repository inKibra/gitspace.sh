import type { ToolCallBlock } from '@gitspace/blocks';
import { RuntimeBrowserExecutionSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, type IconName } from '@gitspace/ui';
import { RichContent, ToolArguments } from './RichContent.js';
import type { ItemInteractionProps } from './TranscriptItemView.js';

// ThinkingStep drops `pending` rows, so every state maps to a visible icon.
const TOOL_ICON: Record<ToolCallBlock['status'], IconName> = { pending: 'circle', running: 'loader', done: 'check', error: 'x', interrupted: 'x' };
const browserExecutionDetails = z.object({ browser: RuntimeBrowserExecutionSchema });

/** One tool call is one reasoning-steps block: header names the tool, the step carries the target and status, details hold input and result. */
export function ToolCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const hasArgs = !(block.input?.length) && block.args !== undefined;
  // Images (screenshots, generated pictures) show below the tool call, even while it is collapsed; its details keep everything else.
  const images = [...block.input ?? [], ...block.result ?? []].flatMap((content) => content.type === 'image' ? [content] : []);
  const input = block.input?.filter((content) => content.type !== 'image') ?? [];
  const result = block.result?.filter((content) => content.type !== 'image') ?? [];
  const hasDetail = hasArgs || input.length + result.length > 0;
  const failed = block.status === 'error';
  // Cloud agents call it web_browser (an OpenAI-reserved name otherwise); machine sessions keep browser.
  const chrome = block.tool === 'browser' || block.tool === 'web_browser' ? browserExecutionDetails.safeParse(block.details) : null;
  return <><ThinkingSteps className="w-full" defaultOpen={failed} open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
    <ThinkingStepsHeader>{block.tool}{chrome?.success ? <span className="ml-2 text-caption font-normal" title={chrome.data.browser.pairingId}>· {chrome.data.browser.name}</span> : null}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      <ThinkingStep label={block.target ?? block.tool} description={failed ? 'failed' : block.status} status={block.status === 'running' ? 'active' : 'complete'} icon={TOOL_ICON[block.status]} isLast>
        {hasDetail ? <ThinkingSteps className="w-full" defaultOpen={failed} open={state?.detailsOpen} onOpenChange={(detailsOpen) => onStateChange?.({ detailsOpen })}>
          <ThinkingStepsHeader>Details</ThinkingStepsHeader>
          <ThinkingStepsContent>
          <div className="flex min-w-0 flex-col gap-2">
            {input.map((content) => <RichContent block={content} key={content.id} />)}
            {hasArgs ? <ToolArguments args={block.args} /> : null}
            {result.map((content) => <RichContent block={content} key={content.id} />)}
          </div>
          </ThinkingStepsContent>
        </ThinkingSteps> : null}
      </ThinkingStep>
    </ThinkingStepsContent>
  </ThinkingSteps>
  {images.length ? <div aria-label={`Images from ${block.tool}`} className="flex min-w-0 flex-wrap gap-2" role="group">{images.map((image) => <RichContent block={image} key={image.id} />)}</div> : null}
  </>;
}
