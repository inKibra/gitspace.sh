import type { ToolCallBlock } from '@gitspace/blocks';
import { ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader } from '@gitspace/ui';
import { RichContent } from './RichContent.js';
import type { ItemInteractionProps } from './TranscriptItemView.js';
import { ItemTime } from './time.js';

/** A custom message the runtime records as a tool call (an async result, a launch completion, a displayed extension
 * message): a reasoning-steps block named by its type, its text in the details, its images below even while closed. */
export function ToolCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const images = block.result?.filter((content) => content.type === 'image') ?? [];
  const result = block.result?.filter((content) => content.type !== 'image') ?? [];
  return <><ThinkingSteps className="w-full" open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
    <ThinkingStepsHeader>{block.tool}<ItemTime at={block.endedAt} className="ml-2" /></ThinkingStepsHeader>
    <ThinkingStepsContent>
      <ThinkingStep label={block.target ?? block.tool} description={block.status} status="complete" icon="check" isLast>
        {result.length ? <div className="flex min-w-0 flex-col gap-2">{result.map((content) => <RichContent block={content} key={content.id} />)}</div> : null}
      </ThinkingStep>
    </ThinkingStepsContent>
  </ThinkingSteps>
  {images.length ? <div aria-label={`Images from ${block.tool}`} className="flex min-w-0 flex-wrap gap-2" role="group">{images.map((image) => <RichContent block={image} key={image.id} />)}</div> : null}
  </>;
}
