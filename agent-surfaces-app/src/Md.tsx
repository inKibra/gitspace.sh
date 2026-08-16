import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Shared off-the-shelf markdown renderer (react-markdown + GFM).
// Use anywhere we display agent-authored markdown (skills, notes, docs).
export function Md({ children, className }: { children: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
