import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';

describe('GitSpaceMarkdown', () => {
  it('renders GFM and fenced code through the shared transcript renderer', () => {
    const html = renderToStaticMarkup(<GitSpaceMarkdown>{`# Result

**Ready**

| Name | State |
| --- | --- |
| Agent | Active |

~~~ts
const ready = true;
~~~

~~~mermaid
graph LR
  A --> B
~~~

$$E = mc^2$$`}</GitSpaceMarkdown>);
    expect(html).toContain('data-streamdown="heading-1"');
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain('data-streamdown="table"');
    expect(html).toContain('data-streamdown="code-block"');
  });

  it('sanitizes executable links and remote images', () => {
    const html = renderToStaticMarkup(<GitSpaceMarkdown>{`[unsafe](javascript:alert(1))

![tracker](https://tracker.invalid/pixel.png)

<script>alert('xss')</script>`}</GitSpaceMarkdown>);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('tracker.invalid');
    expect(html).not.toContain('<script');
  });

  it('shows and links files relative to the drive document it renders, still blocks remote images, and leaves a message\'s relative link as text', () => {
    const html = renderToStaticMarkup(<GitSpaceMarkdown documentUri="drive://workspace/plans/review.md">{`![Proposed accounts](diagrams/accounts.svg)

[Notes](../notes.md)

![tracker](https://tracker.invalid/pixel.png)`}</GitSpaceMarkdown>);
    // The image shows by its drive address (here, with no file source, as that file's card).
    expect(html).toContain(`href="#gitspace-resource=${encodeURIComponent('drive://workspace/plans/diagrams/accounts.svg')}"`);
    expect(html).toContain(`href="#gitspace-resource=${encodeURIComponent('drive://workspace/notes.md')}"`);
    expect(html).not.toContain('tracker.invalid');
    const message = renderToStaticMarkup(<GitSpaceMarkdown>{'The screenshots are in [live-photon/](live-photon/).'}</GitSpaceMarkdown>);
    expect(message).toContain('live-photon/');
    // Neither a link nor Streamdown's link button: a path with no folder to name opens nothing.
    expect(message).not.toMatch(/<a\b[^>]*>live-photon\/|data-streamdown="link"|\[blocked\]/u);
  });

  it('accepts incomplete streaming Markdown without discarding content', () => {
    const html = renderToStaticMarkup(<GitSpaceMarkdown streaming>{'Working on **the answer'}</GitSpaceMarkdown>);
    expect(html).toContain('Working');
    expect(html).toContain('answer');
  });
});
