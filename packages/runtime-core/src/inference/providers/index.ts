import type { Provider } from '@earendil-works/pi-ai';
import { cursorProvider } from './cursor';
import { antigravityProvider, geminiCliProvider } from './google';

export function createLegacyCloudProviders(): readonly Provider[] {
  return [geminiCliProvider(), antigravityProvider(), cursorProvider()];
}
