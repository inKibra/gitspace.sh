import { IconProvider, ShapeProvider, SizeProvider, TooltipProvider, untitledIcons } from '@gitspace/ui';
import { MotionConfig } from 'framer-motion';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MarketingRouter } from './MarketingSite.js';
import { OperatorApp } from './OperatorApp.js';
import { restoreAppearance } from './appearance.js';
import '@gitspace/ui/fluid-theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('GitSpace operator root element is missing');

restoreAppearance();
createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ShapeProvider defaultShape="rounded">
        <SizeProvider defaultSize="default">
          <IconProvider icons={untitledIcons}>
            <TooltipProvider>
              {window.location.pathname.startsWith('/operator') ? <OperatorApp /> : <MarketingRouter />}
            </TooltipProvider>
          </IconProvider>
        </SizeProvider>
      </ShapeProvider>
    </MotionConfig>
  </StrictMode>,
);
