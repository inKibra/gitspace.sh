// Import-free (types only): the Chrome extension bundles this file into its service worker.
import type { RuntimeBrowserRemoteInput } from '@gitspace/protocol-runtime';

/** The DevTools command one input of yours becomes (docs/APERTURE-DESIGN.md §7.1). */
export type RemoteInputCommand =
  | { method: 'Input.dispatchMouseEvent'; params: Record<string, unknown> }
  | { method: 'Input.dispatchKeyEvent'; params: Record<string, unknown> }
  | { method: 'Input.dispatchTouchEvent'; params: Record<string, unknown> }
  | { method: 'Input.insertText'; params: { text: string } };

const MOUSE: Record<'move' | 'down' | 'up', string> = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
const TOUCH: Record<'start' | 'move' | 'end' | 'cancel', string> = { start: 'touchStart', move: 'touchMove', end: 'touchEnd', cancel: 'touchCancel' };

/** A fraction of a viewport side as a whole CSS pixel inside it. */
function pixel(fraction: number, side: number): number {
  return Math.min(Math.max(side - 1, 0), Math.max(0, Math.round(fraction * side)));
}

/**
 * One input as the DevTools command that does it on a tab whose viewport is `viewport` CSS pixels: positions, sent as
 * fractions of the viewport, become pixels of it. A key that types something goes down as `keyDown` with its text, one
 * that types nothing as `rawKeyDown`. A touch end or cancel lists no points, as DevTools requires.
 */
export function remoteInputCommand(input: RuntimeBrowserRemoteInput, viewport: { width: number; height: number }): RemoteInputCommand {
  switch (input.type) {
    case 'mouse': return { method: 'Input.dispatchMouseEvent', params: { type: MOUSE[input.event], x: pixel(input.x, viewport.width), y: pixel(input.y, viewport.height), button: input.button, buttons: input.buttons, clickCount: input.clickCount, modifiers: input.modifiers } };
    case 'wheel': return { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: pixel(input.x, viewport.width), y: pixel(input.y, viewport.height), deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers } };
    case 'key': {
      const type = input.event === 'up' ? 'keyUp' : input.text === undefined ? 'rawKeyDown' : 'keyDown';
      const typed = type === 'keyDown' && input.text !== undefined ? { text: input.text, unmodifiedText: input.text } : {};
      return { method: 'Input.dispatchKeyEvent', params: { type, key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, nativeVirtualKeyCode: input.keyCode, location: input.location, autoRepeat: input.repeat, modifiers: input.modifiers, ...typed } };
    }
    case 'touch': {
      const ending = input.event === 'end' || input.event === 'cancel';
      return { method: 'Input.dispatchTouchEvent', params: { type: TOUCH[input.event], touchPoints: ending ? [] : input.points.map(point => ({ id: point.id, x: pixel(point.x, viewport.width), y: pixel(point.y, viewport.height) })), modifiers: input.modifiers } };
    }
    case 'text': return { method: 'Input.insertText', params: { text: input.text } };
  }
}
