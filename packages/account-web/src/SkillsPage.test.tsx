import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GITSPACE_SKILLS } from '@gitspace/protocol/skills-contract';
import { SkillsPage } from './SkillsPage.js';

describe('SkillsPage', () => {
  it('renders the durable default GitSpace skill catalog', () => {
    const skills = DEFAULT_GITSPACE_SKILLS.map((skill) => ({ ...skill, revision: 1 }));
    const html = renderToStaticMarkup(<SkillsPage projectId="project-a" projectName="GitSpace" projects={[{ id: 'project-a', name: 'GitSpace' }]} skills={skills} update={async () => { throw new Error('not called during render'); }} />);
    expect(html).toContain('review-guide-narrator');
    expect(html).toContain('workspace-services');
    expect(html).toContain('space-artifacts');
    expect(html).toContain('integration-code-mode');
    expect(html).not.toContain('Composio');
  });
});
