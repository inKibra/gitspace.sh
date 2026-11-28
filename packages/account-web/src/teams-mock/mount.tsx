// The providers every GitSpace page mounts under (account-web main.tsx): motion follows the OS, the rounded shape, the
// default size, Untitled UI icons and tooltips.
import { IconProvider, ShapeProvider, SizeProvider, TooltipProvider, untitledIcons } from '@gitspace/ui';
import { MotionConfig } from 'framer-motion';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import '../styles.css';
import './board.css';

export function mount(page: ReactNode): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('The mock root element is missing');
  createRoot(root).render(<StrictMode>
    <MotionConfig reducedMotion="user">
      <ShapeProvider defaultShape="rounded">
        <SizeProvider defaultSize="default">
          <IconProvider icons={untitledIcons}>
            <TooltipProvider>{page}</TooltipProvider>
          </IconProvider>
        </SizeProvider>
      </ShapeProvider>
    </MotionConfig>
  </StrictMode>);
}
