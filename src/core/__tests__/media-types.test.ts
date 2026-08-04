import { describe, expect, it } from 'bun:test';
import { extensionToMime, isMedia, mediaKindFor } from '../media-types.js';

describe('extensionToMime', () => {
  const cases: Array<[string, string]> = [
    ['photo.png', 'image/png'],
    ['photo.JPEG', 'image/jpeg'],
    ['diagram.svg', 'image/svg+xml'],
    ['animation.apng', 'image/apng'],
    ['clip.mov', 'video/quicktime'],
    ['song.mp3', 'audio/mpeg'],
    ['song.wav', 'audio/wav'],
    ['song.ogg', 'audio/ogg'],
    ['song.m4a', 'audio/mp4'],
    ['report.pdf', 'application/pdf'],
    ['page.html', 'text/html'],
    ['page.HTM', 'text/html'],
    ['notes.txt', 'text/plain'],
  ];

  for (const [path, expected] of cases) {
    it(`${path} resolves to ${expected}`, () => {
      expect(extensionToMime(path)).toBe(expected);
    });
  }

  it('accepts a bare extension with or without a leading dot', () => {
    expect(extensionToMime('svg')).toBe('image/svg+xml');
    expect(extensionToMime('.svg')).toBe('image/svg+xml');
    expect(extensionToMime('M4A')).toBe('audio/mp4');
  });

  it('returns undefined for paths without a recognized extension', () => {
    expect(extensionToMime('README')).toBeUndefined();
    expect(extensionToMime('archive.unknown')).toBeUndefined();
  });
});

describe('mediaKindFor', () => {
  const mimeCases: Array<[string, 'image' | 'video' | 'audio' | 'document' | 'text' | 'binary']> = [
    ['image/svg+xml', 'image'],
    ['image/apng', 'image'],
    ['video/quicktime', 'video'],
    ['audio/mpeg', 'audio'],
    ['audio/wav', 'audio'],
    ['audio/ogg', 'audio'],
    ['audio/mp4', 'audio'],
    ['application/pdf', 'document'],
    ['text/html', 'text'],
    ['text/plain', 'text'],
    ['application/octet-stream', 'binary'],
  ];

  for (const [mime, expected] of mimeCases) {
    it(`${mime} is ${expected}`, () => {
      expect(mediaKindFor(mime)).toBe(expected);
    });
  }

  const pathCases: Array<[string, 'image' | 'video' | 'audio' | 'document' | 'text' | 'binary']> = [
    ['art.svg', 'image'],
    ['art.apng', 'image'],
    ['clip.mov', 'video'],
    ['track.mp3', 'audio'],
    ['track.wav', 'audio'],
    ['track.ogg', 'audio'],
    ['track.m4a', 'audio'],
    ['report.pdf', 'document'],
    ['page.html', 'text'],
    ['page.htm', 'text'],
    ['README', 'binary'],
  ];

  for (const [path, expected] of pathCases) {
    it(`${path} is ${expected}`, () => {
      expect(mediaKindFor(path)).toBe(expected);
    });
  }

  it('uses an explicit MIME family when it disagrees with the filename extension', () => {
    expect(mediaKindFor('application/pdf', 'photo.svg')).toBe('document');
    expect(mediaKindFor('text/html', 'clip.mov')).toBe('text');
    expect(mediaKindFor('video/quicktime', 'report.pdf')).toBe('video');
  });

  it('falls back to a MIME or extension hint when the primary value is absent', () => {
    expect(mediaKindFor(undefined, 'image/svg+xml')).toBe('image');
    expect(mediaKindFor(undefined, 'track.m4a')).toBe('audio');
    expect(mediaKindFor('', 'report.pdf')).toBe('document');
  });

  it('classifies absent and unknown values as binary', () => {
    expect(mediaKindFor(undefined)).toBe('binary');
    expect(mediaKindFor('')).toBe('binary');
    expect(mediaKindFor('file.unknown')).toBe('binary');
  });
});

describe('isMedia', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['image/svg+xml', true],
    ['art.apng', true],
    ['video/quicktime', true],
    ['clip.mov', true],
    ['audio/mpeg', true],
    ['track.wav', true],
    ['track.ogg', true],
    ['track.m4a', true],
    ['application/pdf', false],
    ['report.pdf', false],
    ['text/html', false],
    ['page.htm', false],
    ['application/octet-stream', false],
    [undefined, false],
  ];

  for (const [value, expected] of cases) {
    it(`${value ?? 'absent'} is${expected ? '' : ' not'} media`, () => {
      expect(isMedia(value)).toBe(expected);
    });
  }

  it('uses an explicit MIME over a disagreeing extension', () => {
    expect(isMedia('application/pdf', 'photo.svg')).toBe(false);
    expect(isMedia('video/quicktime', 'report.pdf')).toBe(true);
  });
});
