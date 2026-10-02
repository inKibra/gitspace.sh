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

  it('renders images that name loaded artifacts from their object URLs and still blocks remote images', () => {
    const objectUrl = 'blob:https://gitspace.local/3f1c';
    const html = renderToStaticMarkup(<GitSpaceMarkdown resolveImage={(src) => src === 'accounts.svg' ? objectUrl : null}>{`![Proposed accounts](accounts.svg)

![tracker](https://tracker.invalid/pixel.png)`}</GitSpaceMarkdown>);
    expect(html).toContain(`src="${objectUrl}"`);
    expect(html).not.toContain('Image blocked: Proposed accounts');
    expect(html).not.toContain('__gitspace-artifact-image');
    expect(html).not.toContain('tracker.invalid');
  });

  it('accepts incomplete streaming Markdown without discarding content', () => {
    const html = renderToStaticMarkup(<GitSpaceMarkdown streaming>{'Working on **the answer'}</GitSpaceMarkdown>);
    expect(html).toContain('Working');
    expect(html).toContain('answer');
  });
});
