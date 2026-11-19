import { expect, test } from 'vitest';
import { embeddedDriveMedia } from './media-pins.js';

const fence = '```';

test('a message embeds its Markdown images and the drive files its gitspace-ui Image, Video and Sequence frames draw; a plain link embeds nothing', () => {
  const sequence = { title: 'Walkthrough', frames: [
    { content: { type: 'Image', props: { src: 'drive://workspace/frames/one.png', alt: 'One' }, children: [] }, say: 'First.' },
    { content: { type: 'Video', props: { src: 'drive://workspace/frames/two.mp4', alt: 'Two', poster: 'drive://workspace/frames/two.png' }, children: [] }, say: 'Second.' },
  ] };
  const spec = { root: 'card', elements: { card: { type: 'Card', props: { title: 'Shots' }, children: ['shot'] }, shot: { type: 'Image', props: { src: 'drive://workspace/check/dot.svg', alt: 'Dot' }, children: [] } }, state: {} };
  const markdown = [
    'Here it is: ![dot](drive://workspace/check/dot.svg) and ![chart](<drive://workspace/charts/q1.png>).',
    'The notes are at [notes](drive://workspace/notes.md) and drive://workspace/plain.png.',
    `${fence}gitspace-ui\n${JSON.stringify(spec)}\n${fence}`,
    `${fence}gitspace-ui Sequence\n${JSON.stringify(sequence)}\n${fence}`,
    `${fence}gitspace-ui Image\n${JSON.stringify({ src: 'drive://base/logo%20mark.svg', alt: 'Logo' })}\n${fence}`,
  ].join('\n\n');
  expect(embeddedDriveMedia(markdown).sort()).toEqual([
    'drive://base/logo%20mark.svg',
    'drive://workspace/charts/q1.png',
    'drive://workspace/check/dot.svg',
    'drive://workspace/frames/one.png',
    'drive://workspace/frames/two.mp4',
    'drive://workspace/frames/two.png',
  ]);
});

test('a message without drive media embeds nothing', () => {
  expect(embeddedDriveMedia('Done. ![web](https://example.com/a.png) See [the plan](drive://workspace/plan.md).')).toEqual([]);
});
