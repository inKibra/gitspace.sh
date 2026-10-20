import { expect, test } from 'bun:test';
import { browserExtensionUpdateRequired } from './browser.js';

test('a release accepts extensions at its protocol and the one before, and refuses older ones', () => {
  expect([0, 1, 2, 3].map(protocol => browserExtensionUpdateRequired(protocol, 2))).toEqual([true, false, false, false]);
});
