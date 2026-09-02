import { IconProvider, ShapeProvider, SizeProvider, TooltipProvider, untitledIcons } from '@gitspace/ui';
import { MotionConfig } from 'framer-motion';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveApp } from './LiveApp.js';
import { restoreAppearance } from './appearance.js';
import { DesignSystemGallery } from './design-gallery/DesignSystemGallery.js';
import { EnvironmentGallery } from './environment/EnvironmentGallery.js';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('GitSpace root element is missing');

// Canonical Fluid root, per the docs site: motion respects the OS setting,
// the preset pins the rounded shape and default size, and icons resolve to
// Untitled UI through the registry's named icon slots.
restoreAppearance();
createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ShapeProvider defaultShape="rounded">
        <SizeProvider defaultSize="default">
          <IconProvider icons={untitledIcons}>
            <TooltipProvider>
              {new URL(window.location.href).searchParams.get('gallery') === 'design-system'
                ? <DesignSystemGallery />
                : new URL(window.location.href).searchParams.get('gallery') === 'environment'
                  ? <EnvironmentGallery />
                  : <LiveApp />}
            </TooltipProvider>
          </IconProvider>
        </SizeProvider>
      </ShapeProvider>
    </MotionConfig>
  </StrictMode>,
);
