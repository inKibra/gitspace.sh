import { installDomains } from './install-domains.js';
import { IconProvider, ShapeProvider, SizeProvider, TooltipProvider, untitledIcons } from '@gitspace/ui';
import { MotionConfig } from 'framer-motion';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveApp } from './LiveApp.js';
import { SharedGuide } from './SharedGuide.js';
import { SharePage, SHARE_PAGE } from './share/SharePage.js';
import { CaptureSharePage, CAPTURE_SHARE_PAGE } from './share/CaptureSharePage.js';
import { restoreAppearance } from './appearance.js';
import { observeAppViewport } from './app-viewport.js';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('GitSpace root element is missing');

// Canonical Fluid root, per the docs site: motion respects the OS setting,
// the preset pins the rounded shape and default size, and icons resolve to
// Untitled UI through the registry's named icon slots.
restoreAppearance();
const releaseViewport = observeAppViewport();
import.meta.hot?.dispose(releaseViewport);
// The install's domains, named by the Worker that served this page: read before anything checks a hostname, and
// shown, not assumed, when the page does not name them.
try {
  installDomains();
} catch (error) {
  root.textContent = error instanceof Error ? error.message : String(error);
  throw error;
}
createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ShapeProvider defaultShape="rounded">
        <SizeProvider defaultSize="default">
          <IconProvider icons={untitledIcons}>
            <TooltipProvider>
              {/^\/shared-guides\/[^/]+\/[A-Za-z0-9_-]{43}$/u.test(window.location.pathname) ? <SharedGuide />
                : SHARE_PAGE.test(window.location.pathname) ? <SharePage /> : CAPTURE_SHARE_PAGE.test(window.location.pathname) ? <CaptureSharePage /> : <LiveApp />}
            </TooltipProvider>
          </IconProvider>
        </SizeProvider>
      </ShapeProvider>
    </MotionConfig>
  </StrictMode>,
);
