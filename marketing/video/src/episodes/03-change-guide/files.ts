/**
 * The fourteen files of the checkout_v2 flag removal — the same scenario the
 * blog post and its ChangeGuideExplorer island use. Alphabetical here; the
 * BEAT numbers are where the analyzer will put each file in build order.
 */
export type PrFile = {
  path: string;
  adds: number;
  dels: number;
  status?: 'D';
  /** which beat (0-3) claims this file, and its slot within the beat */
  beat: number;
  slot: number;
};

export const FILES: PrFile[] = [
  { path: 'CHANGELOG.md', adds: 6, dels: 0, beat: 2, slot: 3 },
  { path: 'config/flags.test.ts', adds: 0, dels: 41, status: 'D', beat: 2, slot: 1 },
  { path: 'config/flags.ts', adds: 3, dels: 28, beat: 2, slot: 0 },
  { path: 'docs/checkout.md', adds: 9, dels: 22, beat: 2, slot: 2 },
  { path: 'src/api/cart.ts', adds: 4, dels: 9, beat: 0, slot: 2 },
  { path: 'src/api/checkout.ts', adds: 18, dels: 64, beat: 1, slot: 0 },
  { path: 'src/checkout/legacy/v1.ts', adds: 0, dels: 212, status: 'D', beat: 1, slot: 1 },
  { path: 'src/checkout/render.ts', adds: 12, dels: 31, beat: 1, slot: 2 },
  { path: 'src/checkout/totals.test.ts', adds: 48, dels: 12, beat: 3, slot: 0 },
  { path: 'src/checkout/totals.ts', adds: 22, dels: 38, beat: 1, slot: 3 },
  { path: 'src/flags/registry.ts', adds: 2, dels: 17, beat: 0, slot: 0 },
  { path: 'src/middleware/flags.ts', adds: 5, dels: 24, beat: 0, slot: 1 },
  { path: 'src/routes/checkout.tsx', adds: 14, dels: 9, beat: 1, slot: 4 },
  { path: 'test/e2e/checkout.spec.ts', adds: 259, dels: 11, beat: 3, slot: 1 },
];

export const BEATS = [
  { n: 1, title: 'Foundations', sub: 'the flag plumbing' },
  { n: 2, title: 'The removal', sub: 'kill the dead branches' },
  { n: 3, title: 'The purge', sub: 'config · docs · changelog' },
  { n: 4, title: 'The proof', sub: 'the suite that pins it' },
] as const;

/** The journal quote that grounds beat 1's narration (declared BEFORE the edits). */
export const JOURNAL = {
  phase: 'map-reads · phase-start',
  quote:
    'Sweep src for checkout_v2 reads and classify each site: delete, replace with the v2 default, or keep behind config. Expect a note, zero edits.',
} as const;
