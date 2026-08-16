import { type ReactElement } from 'react';
import type { MermaidData } from '../types/content.js';
import { defineRenderer } from './registry.web.js';
import { MermaidDiagram } from './mermaid-diagram.web.js';

defineRenderer<MermaidData>('mermaid', ({ data }): ReactElement => (
  <MermaidDiagram code={data.code} title={data.title} />
));
