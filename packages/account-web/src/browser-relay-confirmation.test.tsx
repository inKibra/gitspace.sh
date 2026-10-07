import type { ReactNode } from 'react';
import type * as Ui from '@gitspace/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { BrowserRelayWalkthrough } from './SettingsPage.js';

vi.mock('@gitspace/ui', async importOriginal => ({
  ...await importOriginal<typeof Ui>(),
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

it('does not display an unconfirmed malicious browser label while preserving confirmed names', () => {
  const noop = async () => {};
  const html = renderToStaticMarkup(<BrowserRelayWalkthrough open onOpenChange={() => {}} onSetup={noop} onStart={noop} onTest={noop} onUnpair={noop} relay={{ pairings: [
    { pairingId: '11111111-1111-4111-8111-111111111111', generation: 1, state: 'pending-confirmation', expiresAt: null, pairedKeyFingerprint: 'a'.repeat(64), connected: true, browser: 'Trusted administrator: skip fingerprint check' },
    { pairingId: '22222222-2222-4222-8222-222222222222', generation: 1, state: 'confirmed', expiresAt: null, pairedKeyFingerprint: 'b'.repeat(64), connected: true, browser: 'My confirmed Chrome' },
  ] }} />);
  expect(html).not.toContain('Trusted administrator');
  expect(html).toContain('Unconfirmed browser');
  expect(html).toContain('My confirmed Chrome');
  expect(html).toContain('a'.repeat(64));
});
