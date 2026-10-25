import { expect, test } from 'bun:test';
import type { RuntimeBrowserRemoteInput } from '@gitspace/protocol-runtime';
import { remoteInputCommand } from './browser-remote-input.js';

const viewport = { width: 1280, height: 720 };

test('positions on the frame land on the same spot of the viewport, never past its edge', () => {
  expect(remoteInputCommand({ type: 'mouse', event: 'move', x: 0.25, y: 0.5, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 }, viewport).params).toMatchObject({ type: 'mouseMoved', x: 320, y: 360 });
  expect(remoteInputCommand({ type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 120, modifiers: 0 }, viewport).params).toEqual({ type: 'mouseWheel', x: 1279, y: 719, deltaX: 0, deltaY: 120, modifiers: 0 });
  expect(remoteInputCommand({ type: 'touch', event: 'start', points: [{ id: 0, x: 0, y: 0.1 }], modifiers: 0 }, viewport).params).toEqual({ type: 'touchStart', touchPoints: [{ id: 0, x: 0, y: 72 }], modifiers: 0 });
});

test('a key that types goes down with its text; one that types nothing goes down raw; a touch ends with no points', () => {
  const key: Extract<RuntimeBrowserRemoteInput, { type: 'key' }> = { type: 'key', event: 'down', key: 'a', code: 'KeyA', keyCode: 65, location: 0, repeat: false, modifiers: 0 };
  expect(remoteInputCommand({ ...key, text: 'a' }, viewport)).toEqual({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, location: 0, autoRepeat: false, modifiers: 0, text: 'a', unmodifiedText: 'a' } });
  expect(remoteInputCommand({ ...key, key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, viewport).params).toMatchObject({ type: 'rawKeyDown', key: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  expect(remoteInputCommand({ ...key, event: 'up', text: 'a' }, viewport).params).not.toHaveProperty('text');
  expect(remoteInputCommand({ type: 'touch', event: 'end', points: [{ id: 0, x: 0.5, y: 0.5 }], modifiers: 0 }, viewport).params).toEqual({ type: 'touchEnd', touchPoints: [], modifiers: 0 });
});
