import { expect, test } from 'bun:test';
import { captureMaskedUrl } from './browser-capture-rules.js';
import { RuntimeBrowserCaptureSchema } from './browser-capture-tracks.js';

const saved = { captureId: '00000000-0000-4000-8000-000000000001', name: 'Order · 2026-10-24 10:00 UTC', by: 'you', source: 'relay', browser: 'Work Chrome', page: { url: 'https://example.com/', title: 'Order' }, target: null, startedAt: '2026-10-24T10:00:00.000Z', endedAt: '2026-10-24T10:01:00.000Z', state: 'saved', reason: null } as const;

test('capture.json written before steps and layout reads as version 2; version 2 keeps its steps, layout, comments and skill', () => {
  const video = { path: 'video.webm', mediaType: 'video/webm', sound: true, durationMs: 60_000 };
  expect(RuntimeBrowserCaptureSchema.parse({ ...saved, version: 1, tracks: { video } })).toEqual({ ...saved, version: 2, tracks: { video } });
  const tracks = { video, steps: { path: 'steps.json', count: 12 }, layout: { path: 'layout.jsonl', count: 30 }, comments: { count: 2 } };
  expect(RuntimeBrowserCaptureSchema.parse({ ...saved, version: 2, tracks, skill: { path: '.agents/skills/order/SKILL.md', commit: 'a3f9c21' } })).toMatchObject({ version: 2, tracks, skill: { commit: 'a3f9c21' } });
  expect(RuntimeBrowserCaptureSchema.safeParse({ ...saved, version: 1, tracks: { steps: { path: 'steps.json', count: 1 }, extra: {} } }).success).toBe(false);
});

test('a step’s address keeps no credentials and masks query values whose names look secret', () => {
  expect(captureMaskedUrl('https://ada:pw@shop.example/pay?card_number=4242&step=2&access_token=t&otp=1')).toBe('https://shop.example/pay?card_number=%C2%ABsecret%C2%BB&step=2&access_token=%C2%ABsecret%C2%BB&otp=%C2%ABsecret%C2%BB');
  expect(captureMaskedUrl('about:blank')).toBe('about:blank');
});
